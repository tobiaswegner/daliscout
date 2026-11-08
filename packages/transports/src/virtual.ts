import type { BusFrame, FrameError } from '@dali-scout/core';
import { frameDurationUs } from '@dali-scout/core';
import { TransportBase } from './base.js';
import type { TransportCaps, TxFrame } from './types.js';

/** Minimum gap after any frame before the next forward frame (22 Te). */
const FORWARD_GUARD_US = 9_170;
/** Default delay of a backward frame after the forward frame (7..22 Te = 2.9..9.2 ms). */
const DEFAULT_REPLY_DELAY_US = 6_000;

export interface VirtualBusOptions {
  /**
   * Stamp frames as they would appear on a real DALI wire: a frame occupies the bus for its
   * duration, forward frames keep a 9.17 ms guard, backward frames follow the forward frame
   * after the reply delay. Off by default (frames carry the host time they were sent).
   */
  wireTiming?: boolean;
}

type Pending =
  | { from: VirtualTransport; frame: Omit<BusFrame, 'dir' | 'source'>; replyDelayUs?: undefined }
  | { from: VirtualTransport; frame: Omit<BusFrame, 'dir' | 'source'>; replyDelayUs: number };

/**
 * In-process DALI bus. Every open endpoint sees every frame, in the same order; the sender sees
 * its own frame as dir 'tx', everybody else as 'rx'. Frames sent while another is being
 * delivered (e.g. a simulated gear answering) are queued, so a reply never overtakes the query.
 */
export class VirtualBus {
  private endpoints = new Set<VirtualTransport>();
  private queue: Pending[] = [];
  private draining = false;
  private busyUntil = 0;
  private lastForwardEnd = 0;
  readonly wireTiming: boolean;

  constructor(readonly now: () => number = defaultClock(), opts: VirtualBusOptions = {}) {
    this.wireTiming = !!opts.wireTiming;
  }

  createEndpoint(name: string, opts: { canSend?: boolean; canReply?: boolean } = {}): VirtualTransport {
    return new VirtualTransport(this, name, opts);
  }

  /** @internal */ attach(e: VirtualTransport): void { this.endpoints.add(e); }
  /** @internal */ detach(e: VirtualTransport): void { this.endpoints.delete(e); }

  /** @internal */
  deliver(from: VirtualTransport, frame: Omit<BusFrame, 'dir' | 'source'>, replyDelayUs?: number): void {
    this.queue.push({ from, frame, replyDelayUs } as Pending);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let p = this.queue.shift(); p; p = this.queue.shift()) this.dispatch(p);
    } finally {
      this.draining = false;
    }
  }

  private dispatch(p: Pending): void {
    const frame = { ...p.frame };
    if (this.wireTiming) this.stamp(frame, p.replyDelayUs);
    else if (p.replyDelayUs !== undefined) frame.ts = this.now() + p.replyDelayUs;
    for (const e of this.endpoints) e.receive({ ...frame, dir: e === p.from ? 'tx' : 'rx', source: p.from.id });
  }

  private stamp(frame: Omit<BusFrame, 'dir' | 'source'>, replyDelayUs?: number): void {
    const dur = frame.kind === 'error' ? 0 : Math.round(frameDurationUs(frame.bits));
    if (replyDelayUs !== undefined) {
      frame.ts = this.lastForwardEnd + replyDelayUs;       // answer or collision
      this.busyUntil = Math.max(this.busyUntil, frame.ts + dur + FORWARD_GUARD_US);
    } else {
      frame.ts = Math.max(frame.ts, this.busyUntil);       // forward frame waits for a free bus
      this.lastForwardEnd = frame.ts + dur;
      this.busyUntil = this.lastForwardEnd + FORWARD_GUARD_US;
    }
  }
}

function defaultClock(): () => number {
  const t0 = performance.now();
  return () => Math.round((performance.now() - t0) * 1000);
}

export class VirtualTransport extends TransportBase {
  readonly caps: TransportCaps;

  constructor(
    private readonly bus: VirtualBus,
    name: string,
    opts: { canSend?: boolean; canReply?: boolean }
  ) {
    super(name, `Virtual bus (${name})`);
    this.caps = {
      canSniff: true, canSend: opts.canSend ?? true,
      canReply: opts.canReply ?? false, hasHwTimestamps: true
    };
    if (this.caps.canReply) {
      this.sendBackward = this.doSendBackward;
      this.sendCollision = this.doSendCollision;
    }
  }

  sendBackward?: (byte: number, delayUs?: number) => Promise<void>;
  /** Several gears answered with different values: the bus shows a collision. Only with canReply. */
  sendCollision?: (delayUs?: number) => Promise<void>;

  async open(): Promise<void> {
    this.bus.attach(this);
    this.setStatus('open');
  }
  async close(): Promise<void> {
    this.bus.detach(this);
    this.setStatus('closed');
  }

  async send(frame: TxFrame): Promise<void> {
    if (!this.caps.canSend) return super.send(frame);
    if (this._status !== 'open') throw new Error('Transport is not open');
    const bits = frame.bits ?? frame.data.length * 8;
    const n = frame.sendTwice ? 2 : 1;
    for (let i = 0; i < n; i++) {
      this.bus.deliver(this, {
        ts: this.bus.now(), kind: 'forward', bits, data: frame.data.slice()
      });
    }
  }

  private doSendBackward = async (byte: number, delayUs = DEFAULT_REPLY_DELAY_US): Promise<void> => {
    if (this._status !== 'open') throw new Error('Transport is not open');
    this.bus.deliver(this, { ts: this.bus.now(), kind: 'backward', bits: 8, data: Uint8Array.of(byte) }, delayUs);
  };

  private doSendCollision = async (delayUs = DEFAULT_REPLY_DELAY_US): Promise<void> => {
    if (this._status !== 'open') throw new Error('Transport is not open');
    const error: FrameError = 'collision';
    this.bus.deliver(this, {
      ts: this.bus.now(), kind: 'error', bits: 0, data: new Uint8Array(0), error
    }, delayUs);
  };

  /** @internal */
  receive(f: BusFrame): void { this.emitFrame(f); }
}
