import type { Row } from './session.js';

/** On-wire duration of a frame in µs: 1200 baud Manchester, start + data + 2 stop bits. */
export function frameDurationUs(bits: number): number {
  return (1 + bits + 2) * (1e6 / 1200);
}

export interface StatsSnapshot {
  total: number;
  forward: number;
  backward: number;
  errors: number;
  unknown: number;
  unanswered: number;
  /** Frames per second over the trailing window. */
  framesPerSecond: number;
  /** Share of bus time occupied by frames over the trailing window, 0..1. */
  busLoad: number;
  perAddress: { label: string; count: number }[];
}

/** Incremental statistics over a capture. Time comes from frame timestamps, so replay works too. */
export class StatsTracker {
  private total = 0; private forward = 0; private backward = 0; private errors = 0; private unknown = 0;
  private perAddr = new Map<string, number>();
  private window: { ts: number; dur: number }[] = [];
  private head = 0;
  private lastTs = 0;

  constructor(private readonly windowUs = 1_000_000) {}

  add(row: Row): void {
    const f = row.frame;
    this.total++;
    if (f.kind === 'forward') this.forward++;
    else if (f.kind === 'backward') this.backward++;
    else this.errors++;
    if (row.decoded.unknown && f.kind !== 'error') this.unknown++;
    const a = row.decoded.addr;
    if (a && f.kind === 'forward') {
      const label = a.value !== undefined ? `${a.kind === 'short' ? 'Short' : 'Group'} ${a.value}` : a.kind;
      this.perAddr.set(label, (this.perAddr.get(label) ?? 0) + 1);
    }
    this.lastTs = f.ts;
    this.window.push({ ts: f.ts, dur: f.kind === 'error' ? 0 : frameDurationUs(f.bits) });
    this.trim();
  }

  private trim(): void {
    const cut = this.lastTs - this.windowUs;
    while (this.head < this.window.length && this.window[this.head]!.ts < cut) this.head++;
    if (this.head > 1024) { this.window = this.window.slice(this.head); this.head = 0; }
  }

  /** @param unanswered number of queries without reply (CaptureSession.unanswered) */
  snapshot(unanswered = 0): StatsSnapshot {
    const w = this.window.slice(this.head);
    const busy = w.reduce((s, x) => s + x.dur, 0);
    return {
      total: this.total, forward: this.forward, backward: this.backward, errors: this.errors,
      unknown: this.unknown, unanswered,
      framesPerSecond: w.length / (this.windowUs / 1e6),
      busLoad: Math.min(1, busy / this.windowUs),
      perAddress: [...this.perAddr].map(([label, count]) => ({ label, count })).sort((x, y) => y.count - x.count)
    };
  }

  reset(): void {
    this.total = this.forward = this.backward = this.errors = this.unknown = 0;
    this.perAddr.clear(); this.window = []; this.head = 0; this.lastTs = 0;
  }
}
