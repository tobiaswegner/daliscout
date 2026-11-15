import type { BusFrame } from '@dali-scout/core';
import { TransportBase, createHostClock } from '../base.js';
import type { TransportCaps, TxFrame } from '../types.js';
import {
  DEFAULT_PORT, decodePacket, encodeBackward, encodeForward, type Dali104Frame
} from './codec.js';
import { nodeUdp, type UdpEndpoint, type UdpFactory, type UdpPeer } from './udp.js';

export interface Dali104Options {
  /**
   * `client`: we are the controller; we send forward packets to the gateway at host:port and receive its
   *           answers (can send, cannot reply).
   * `server`: we are the telecommunication unit / bus; we listen on `port` and receive the forward packets
   *           of a controller or gateway driver, and can answer them (what the gear simulator needs).
   */
  role: 'client' | 'server';
  /** Gateway address (client role). */
  host?: string;
  port?: number;
  /** Local address to listen on (server role). Default 127.0.0.1: nothing outside this machine can reach it. */
  bindHost?: string;
  /** System address used in packets we send (client) / expected (ignored when unset). Default 0. */
  systemAddress?: number;
  id?: string;
  label?: string;
  udp?: UdpFactory;
  now?: () => number;
  /** Retry opening with 1, 2, 4 … 16 s backoff after the socket fails. Default true. */
  autoReconnect?: boolean;
  /** Client role: how long an unanswered query is remembered. Default 2 s. */
  answerTimeoutMs?: number;
}

interface Query { frame: Dali104Frame; timer: ReturnType<typeof setTimeout> }
interface Pending { peer: UdpPeer; seq: number; systemAddress: number; frame: Dali104Frame }

/**
 * DALI-over-IP (IEC 62386-104 UDP) transport. See codec.ts for the (reference-simulator derived) format.
 * A 104 frame that carries a device type is shown as the two DALI frames ENABLE DEVICE TYPE (0xC1) + the
 * command, so the decoder and the gears see what a bus would carry; the other direction folds them back.
 */
export class Dali104Transport extends TransportBase {
  readonly caps: TransportCaps;
  /** Datagrams that were not understood, and answers nobody asked for. */
  ignored = 0;
  /** Valid forward packets received (server) / answers received (client), and answers sent (server). */
  received = 0;
  answered = 0;
  /** Diagnostics: first bytes of the last datagram we could not parse, and who sent the last valid packet. */
  lastIgnoredHex?: string;
  lastPeer?: string;
  /** The local port in server role (useful when port 0 was requested). */
  localPort = 0;

  private readonly udp: UdpFactory;
  private readonly now: () => number;
  private readonly role: 'client' | 'server';
  private readonly peer?: UdpPeer;
  private ep?: UdpEndpoint;
  private offs: (() => void)[] = [];
  private seq = Math.floor(Math.random() * 0x10000);
  private queries = new Map<number, Query>();
  private pending?: Pending;
  private pendingDeviceType?: number;
  private retry?: ReturnType<typeof setTimeout>;
  private backoff = 1000;
  private wantOpen = false;

  constructor(private readonly opts: Dali104Options) {
    const role = opts.role;
    const port = opts.port ?? DEFAULT_PORT;
    super(opts.id ?? 'dali-ip', opts.label ?? (role === 'client'
      ? `DALI-over-IP → ${opts.host ?? '?'}:${port}`
      : `DALI-over-IP server :${port}`));
    this.role = role;
    this.udp = opts.udp ?? nodeUdp;
    this.now = opts.now ?? createHostClock();
    if (role === 'client') {
      if (!opts.host) throw new Error('A DALI-over-IP client needs a gateway host');
      this.peer = { address: opts.host, port };
    }
    this.caps = role === 'client'
      ? { canSniff: false, canSend: true, canReply: false, hasHwTimestamps: false }
      : { canSniff: true, canSend: false, canReply: true, hasHwTimestamps: false };
  }

  async open(): Promise<void> {
    if (this._status === 'open') return;
    this.wantOpen = true;
    await this.bindNow(true);
  }

  async close(): Promise<void> {
    this.wantOpen = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    await this.teardown();
    this.setStatus('closed');
  }

  async send(frame: TxFrame): Promise<void> {
    if (this.role !== 'client') throw new Error(`${this.label}: a server cannot send forward frames`);
    if (this._status !== 'open' || !this.ep) throw new Error('Transport is not open');
    const bits = frame.bits ?? frame.data.length * 8;
    if (bits !== 16 || frame.data.length !== 2) {
      throw new RangeError('DALI-over-IP forward packets carry 16-bit DALI frames only');
    }
    const [address, opcode] = [frame.data[0]!, frame.data[1]!];
    if (address === 0xc1) {  // ENABLE DEVICE TYPE: travels as the device type of the next packet
      this.pendingDeviceType = opcode;
      this.emitFrame(this.make('tx', 16, frame.data));
      return;
    }
    const f: Dali104Frame = { address, opcode };
    if (this.pendingDeviceType !== undefined) { f.deviceType = this.pendingDeviceType; this.pendingDeviceType = undefined; }
    const seq = this.nextSeq();
    const timer = setTimeout(() => this.queries.delete(seq), this.opts.answerTimeoutMs ?? 2000);
    this.queries.set(seq, { frame: f, timer });
    try {
      // a send-twice command goes out once: the telecommunication unit sends it twice on the bus (104 9.4)
      await this.ep.send(encodeForward(seq, this.opts.systemAddress ?? 0, f), this.peer!);
    } catch (e) {
      clearTimeout(timer);
      this.queries.delete(seq);
      throw e;
    }
    this.emitFrame(this.make('tx', 16, Uint8Array.of(address, opcode)));
  }

  /** Server role: answer the forward packet received last. `delayUs` is ignored (the network has no bit timing). */
  async sendBackward(byte: number, _delayUs?: number): Promise<void> {
    if (this.role !== 'server') throw new Error(`${this.label}: only a server can send backward frames`);
    const p = this.pending;
    if (!p || !this.ep) return;           // nothing to answer (or already answered)
    this.pending = undefined;
    await this.ep.send(encodeBackward(p.seq, p.systemAddress, p.frame, byte), p.peer);
    this.answered++;
    this.emitFrame(this.make('tx', 8, Uint8Array.of(byte)));
  }

  // ---- internals ----------------------------------------------------------------------

  private make(dir: 'rx' | 'tx', bits: number, data: Uint8Array): BusFrame {
    return { ts: this.now(), dir, kind: bits === 8 ? 'backward' : 'forward', bits, data, source: this.id };
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  private async bindNow(throwOnFail: boolean): Promise<void> {
    this.setStatus('opening');
    try {
      const ep = this.udp();
      this.ep = ep;
      this.offs.push(ep.onMessage((d, from) => this.onDatagram(d, from)));
      this.offs.push(ep.onError((e) => this.onSocketError(e)));
      this.localPort = await ep.bind(
        this.role === 'server' ? (this.opts.port ?? DEFAULT_PORT) : 0,
        this.role === 'server' ? (this.opts.bindHost ?? '127.0.0.1') : undefined
      );
      this.backoff = 1000;
      this.setStatus('open');
    } catch (e) {
      await this.teardown();
      this.setStatus('error', e as Error);
      // the first open() reports the failure to the caller; later retries run silently in the background
      if (throwOnFail) { this.wantOpen = false; throw e; }
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (!this.wantOpen || this.opts.autoReconnect === false || this.retry) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 16000);
    this.retry = setTimeout(() => { this.retry = undefined; if (this.wantOpen) void this.bindNow(false); }, wait);
  }

  private onSocketError(e: Error): void {
    if (!this.wantOpen) return;
    void this.teardown().then(() => { this.setStatus('error', e); this.scheduleRetry(); });
  }

  private onDatagram(raw: Uint8Array, from: UdpPeer): void {
    const p = decodePacket(raw);
    if (!p) {
      this.ignored++;
      this.lastIgnoredHex = Array.from(raw.subarray(0, 24), (b) => b.toString(16).padStart(2, '0')).join(' ') + (raw.length > 24 ? ` … (${raw.length} bytes)` : '');
      return;
    }
    this.lastPeer = `${from.address}:${from.port}`;
    if (this.role === 'server') {
      if (p.type !== 'forward') { this.ignored++; return; }
      // set before the frames are emitted: a listener (the gear simulator) answers from inside the callback
      this.received++;
      this.pending = { peer: from, seq: p.seq, systemAddress: p.systemAddress, frame: p.frame };
      if (p.frame.deviceType !== undefined) this.emitFrame(this.make('rx', 16, Uint8Array.of(0xc1, p.frame.deviceType)));
      this.emitFrame(this.make('rx', 16, Uint8Array.of(p.frame.address, p.frame.opcode)));
      return;
    }
    // client: answers to our queries
    if (p.type === 'backward' && p.answer !== undefined) {
      const q = this.queries.get(p.seq);
      if (!q) { this.ignored++; return; }
      clearTimeout(q.timer);
      this.queries.delete(p.seq);
      this.received++;
      this.emitFrame(this.make('rx', 8, Uint8Array.of(p.answer)));
    } else {
      this.ignored++;
    }
  }

  private async teardown(): Promise<void> {
    this.offs.forEach((o) => o());
    this.offs = [];
    for (const q of this.queries.values()) clearTimeout(q.timer);
    this.queries.clear();
    this.pending = undefined;
    const ep = this.ep;
    this.ep = undefined;
    if (ep) { try { await ep.close(); } catch { /* already gone */ } }
  }
}
