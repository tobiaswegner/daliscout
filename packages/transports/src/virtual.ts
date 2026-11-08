import type { BusFrame } from '@dali-scout/core';
import { TransportBase } from './base.js';
import type { TransportCaps, TxFrame } from './types.js';

/**
 * In-process DALI bus. Every open endpoint sees every frame; the sender sees its own
 * frame as dir 'tx', everybody else as 'rx'. (Backward-frame timing/collision modelling
 * arrives with the simulator in milestone 3.)
 */
export class VirtualBus {
  private endpoints = new Set<VirtualTransport>();
  constructor(readonly now: () => number = defaultClock()) {}

  createEndpoint(name: string, opts: { canSend?: boolean; canReply?: boolean } = {}): VirtualTransport {
    return new VirtualTransport(this, name, opts);
  }

  /** @internal */ attach(e: VirtualTransport): void { this.endpoints.add(e); }
  /** @internal */ detach(e: VirtualTransport): void { this.endpoints.delete(e); }

  /** @internal */
  deliver(from: VirtualTransport, frame: Omit<BusFrame, 'dir' | 'source'>): void {
    for (const e of this.endpoints) {
      e.receive({ ...frame, dir: e === from ? 'tx' : 'rx', source: from.id });
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
    if (this.caps.canReply) this.sendBackward = this.doSendBackward;
  }

  sendBackward?: (byte: number, delayUs?: number) => Promise<void>;

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

  private doSendBackward = async (byte: number, delayUs = 0): Promise<void> => {
    if (this._status !== 'open') throw new Error('Transport is not open');
    this.bus.deliver(this, {
      ts: this.bus.now() + delayUs, kind: 'backward', bits: 8, data: Uint8Array.of(byte)
    });
  };

  /** @internal */
  receive(f: BusFrame): void { this.emitFrame(f); }
}
