import type { BusFrame } from '@dali-scout/core';
import { TransportBase } from './base.js';
import type { TransportCaps } from './types.js';

export interface ReplayOptions {
  /** Playback speed multiplier; Infinity = as fast as possible. Default 1. */
  speed?: number;
  loop?: boolean;
  /** Cap on inter-frame gaps in ms (long idle gaps in captures are boring). Default 2000. */
  maxGapMs?: number;
}

/** Plays a recorded capture back as if it were a live bus. Receive-only. */
export class ReplayTransport extends TransportBase {
  readonly caps: TransportCaps = {
    canSniff: true, canSend: false, canReply: false, hasHwTimestamps: true
  };
  private timer?: ReturnType<typeof setTimeout>;
  private index = 0;
  private opts: Required<ReplayOptions>;

  constructor(private frames: readonly BusFrame[], opts: ReplayOptions = {}, id = 'replay') {
    super(id, 'Capture replay');
    this.opts = { speed: opts.speed ?? 1, loop: opts.loop ?? false, maxGapMs: opts.maxGapMs ?? 2000 };
  }

  async open(): Promise<void> {
    if (this._status === 'open') return;
    this.index = 0;
    this.setStatus('open');
    this.schedule(0);
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.setStatus('closed');
  }

  setSpeed(speed: number): void { this.opts.speed = speed; }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => this.step(), delayMs);
  }

  private step(): void {
    if (this._status !== 'open') return;
    const f = this.frames[this.index];
    if (!f) {
      if (this.opts.loop && this.frames.length > 0) { this.index = 0; this.schedule(this.opts.maxGapMs); return; }
      void this.close();
      return;
    }
    this.emitFrame({ ...f, source: this.id });
    this.index++;
    const next = this.frames[this.index];
    if (!next) { this.schedule(0); return; }
    const gapMs = Math.min(Math.max(0, (next.ts - f.ts) / 1000), this.opts.maxGapMs);
    this.schedule(this.opts.speed === Infinity ? 0 : gapMs / this.opts.speed);
  }
}
