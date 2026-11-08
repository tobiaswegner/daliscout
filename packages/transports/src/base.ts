import type { BusFrame } from '@dali-scout/core';
import type { DaliTransport, TransportCaps, TransportStatus, TxFrame } from './types.js';

/** Shared listener plumbing for transports. */
export abstract class TransportBase implements DaliTransport {
  abstract readonly caps: TransportCaps;
  protected _status: TransportStatus = 'closed';
  private frameListeners = new Set<(f: BusFrame) => void>();
  private statusListeners = new Set<(s: TransportStatus, e?: Error) => void>();

  constructor(readonly id: string, readonly label: string) {}

  get status(): TransportStatus { return this._status; }

  abstract open(): Promise<void>;
  abstract close(): Promise<void>;
  async send(_frame: TxFrame): Promise<void> {
    throw new Error(`${this.label}: sending is not supported`);
  }

  onFrame(cb: (f: BusFrame) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }
  onStatus(cb: (s: TransportStatus, e?: Error) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  protected emitFrame(f: BusFrame): void {
    for (const cb of this.frameListeners) cb(f);
  }
  protected setStatus(s: TransportStatus, err?: Error): void {
    this._status = s;
    for (const cb of this.statusListeners) cb(s, err);
  }
}

/** Monotonic host clock in microseconds, starting near 0. */
export function createHostClock(): () => number {
  const t0 = performance.now();
  return () => Math.round((performance.now() - t0) * 1000);
}
