import type { BusFrame, FrameError } from '@dali-scout/core';
import { TransportBase, createHostClock } from '../base.js';
import type { DeviceStream, StreamFactory, TransportCaps, TxFrame } from '../types.js';
import {
  Cmd, LubaParser, TickClock, buildAddFrame, buildAutoAnswer, buildQueryDescriptor, buildReadSettings,
  buildWriteSettings, parseAddFrameResponse, parseDescriptor, parseEvent, parseSettings,
  type LubaDescriptor, type LubaEvent, type LubaSettings
} from './codec.js';

export interface LubaOptions {
  id?: string;
  label?: string;
  /** Host clock in µs (injectable for tests). */
  now?: () => number;
  /** DALI priority 1..5 for frames we send. Default 3. */
  priority?: number;
  /** DALI line index for multi-line interfaces. Default 0. */
  line?: number;
  /** Per-request timeout in ms. Default 1000. */
  timeoutMs?: number;
}

interface Waiter { resolve: (d: Uint8Array) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/**
 * Lunatone DALI-2 USB (and other LUBA devices) over a serial stream.
 * Sniffs all bus traffic through LUBA events (frames sent, answers, frames from other masters,
 * collisions, bus faults). It can NOT act as a gear: LUBA has no "send backward frame" command,
 * only up to four fixed auto-answers (see setAutoAnswer), hence caps.canReply === false.
 */
export class LubaTransport extends TransportBase {
  readonly caps: TransportCaps = { canSniff: true, canSend: true, canReply: false, hasHwTimestamps: true };
  descriptor?: LubaDescriptor;
  settings?: LubaSettings;
  /** Parser diagnostics. */
  readonly parser = new LubaParser();

  private stream?: DeviceStream;
  private offs: (() => void)[] = [];
  private waiters = new Map<number, Waiter[]>();
  private clock = new TickClock(0);
  private hasTick = true;
  private hasLine = true;
  private readonly now: () => number;

  constructor(private readonly factory: StreamFactory, private readonly opts: LubaOptions = {}) {
    super(opts.id ?? 'luba', opts.label ?? 'Lunatone DALI-2 USB (LUBA)');
    this.now = opts.now ?? createHostClock();
  }

  async open(): Promise<void> {
    if (this._status === 'open') return;
    this.setStatus('opening');
    try {
      this.stream = await this.factory();
      this.offs.push(this.stream.onData((d) => this.onBytes(d)));
      this.offs.push(this.stream.onClose((err) => this.onStreamClosed(err)));

      this.descriptor = parseDescriptor(await this.request(buildQueryDescriptor(), Cmd.QUERY_DEVICE_DESCRIPTOR + 1));
      this.clock.setTickUs(this.descriptor.tickUs);
      const current = parseSettings(await this.request(buildReadSettings(), Cmd.SETTINGS + 1));
      // Only the event filter changes: report everything, including tick and line index.
      this.settings = parseSettings(
        await this.request(buildWriteSettings({ ...current, eventFilter: 0 }), Cmd.SETTINGS + 1)
      );
      this.hasTick = (this.settings.eventFilter & 0x08) === 0;
      this.hasLine = (this.settings.eventFilter & 0x04) === 0;
      this.setStatus('open');
    } catch (e) {
      await this.teardown();
      this.setStatus('error', e as Error);
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.teardown();
    this.setStatus('closed');
  }

  async send(frame: TxFrame): Promise<void> {
    if (this._status !== 'open') throw new Error('Transport is not open');
    const bits = frame.bits ?? frame.data.length * 8;
    const msg = buildAddFrame({
      data: frame.data, bits, sendTwice: frame.sendTwice, waitForResponse: frame.expectReply,
      priority: this.opts.priority
    }, this.opts.line ?? 0);
    const respCmd = bits === 16 ? Cmd.ADD_FRAME_16 + 1 : bits === 24 ? Cmd.ADD_FRAME_24 + 1 : Cmd.ADD_FRAME + 1;
    const res = parseAddFrameResponse(await this.request(msg, respCmd));
    if (!res.ok) throw new Error(`DALI send failed: ${res.error}`);
    // the frame itself shows up as a 'sent' event once it was put on the bus
  }

  /** Let the interface answer `frame` with `answer` on its own (4 slots, 8-bit answers only). */
  async setAutoAnswer(slot: number, bits: number, frame: Uint8Array, answer: number): Promise<void> {
    await this.request(buildAutoAnswer(slot, bits, frame, answer, this.opts.line ?? 0), Cmd.AUTO_ANSWER + 1);
  }

  // ---- internals ----------------------------------------------------------------------

  private request(msg: Uint8Array, respCmd: number): Promise<Uint8Array> {
    const stream = this.stream;
    if (!stream) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(respCmd) ?? [];
        const i = list.findIndex((w) => w.timer === timer);
        if (i >= 0) list.splice(i, 1);
        reject(new Error(`No response from device (command ${msg[1]})`));
      }, this.opts.timeoutMs ?? 1000);
      const list = this.waiters.get(respCmd) ?? [];
      list.push({ resolve, reject, timer });
      this.waiters.set(respCmd, list);
      stream.write(msg).catch((e) => {
        clearTimeout(timer);
        reject(e as Error);
      });
    });
  }

  private onBytes(chunk: Uint8Array): void {
    for (const m of this.parser.push(chunk)) {
      if (m.cmd === Cmd.EVENT) {
        try { this.onEvent(m.data); } catch { /* malformed event: ignore, parser stats stay valid */ }
        continue;
      }
      const w = this.waiters.get(m.cmd)?.shift();
      if (w) { clearTimeout(w.timer); w.resolve(m.data); }
    }
  }

  private onEvent(data: Uint8Array): void {
    const { tick, event } = parseEvent(data, this.hasTick, this.hasLine);
    const ts = this.clock.stamp(tick, this.now());
    const frame = (dir: 'rx' | 'tx', bits: number, bytes: Uint8Array): BusFrame => ({
      ts, dir, kind: bits === 8 ? 'backward' : 'forward', bits, data: bytes, source: this.id
    });
    const error = (e: FrameError): BusFrame => ({
      ts, dir: 'rx', kind: 'error', bits: 0, data: new Uint8Array(0), error: e, source: this.id
    });
    const out = mapEvent(event, frame, error);
    if (out) this.emitFrame(out);
  }

  private onStreamClosed(err?: Error): void {
    if (this._status === 'closed') return;
    void this.teardown().then(() => this.setStatus('error', err ?? new Error('Device disconnected')));
  }

  private async teardown(): Promise<void> {
    this.offs.forEach((o) => o());
    this.offs = [];
    for (const list of this.waiters.values()) {
      for (const w of list) { clearTimeout(w.timer); w.reject(new Error('Connection closed')); }
    }
    this.waiters.clear();
    const s = this.stream;
    this.stream = undefined;
    if (s) { try { await s.close(); } catch { /* already gone */ } }
  }
}

function mapEvent(
  ev: LubaEvent,
  frame: (dir: 'rx' | 'tx', bits: number, bytes: Uint8Array) => BusFrame,
  error: (e: FrameError) => BusFrame
): BusFrame | undefined {
  switch (ev.type) {
    case 'sent': return frame('tx', ev.bits, ev.frame);
    case 'received': return frame('rx', ev.bits, ev.frame);
    case 'response':
      if (ev.answer === 'none') return undefined; // the monitor derives "no answer" itself
      if (ev.answer === 'collision') return error('collision');
      return frame('rx', 8, Uint8Array.of(ev.answer));
    case 'send-error':
      return ev.reason === 'collision' ? error('collision') : ev.reason === 'bus-error' ? error('bus-fault') : undefined;
    case 'receive-error': return error(ev.reason === 'framing' ? 'framing' : 'short');
    case 'bus':
      return ev.event === 'bus-error' || ev.event === 'system-error' ? error('bus-fault')
        : ev.event === 'bus-restored' ? error('bus-restored') : undefined;
    default: return undefined;
  }
}
