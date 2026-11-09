import type { BusFrame, FrameError } from '@dali-scout/core';
import { TransportBase, createHostClock } from '../base.js';
import type { DeviceStream, StreamFactory, TransportCaps, TxFrame } from '../types.js';
import {
  STATUS, decodeReport, encodeAnswer, encodeInit, encodeSend, reportFrame, reportStatus, type Report
} from './legacy-codec.js';

export interface LegacyHidOptions {
  id?: string;
  label?: string;
  now?: () => number;
  /** How long to wait for the device to echo a sent frame before giving up on it. Default 500 ms. */
  echoTimeoutMs?: number;
}

interface Outstanding { echoesLeft: number; timer: ReturnType<typeof setTimeout> }

/**
 * Tridonic / Lunatone "DALI USB" (24138923) over HID. See legacy-codec.ts for the (unverified)
 * wire format. The device has no timestamps, so frames are stamped with the host clock when the
 * report arrives (USB polling adds a few ms of jitter). Backward frames are sent with
 * command 0x15 (`sendBackward`); the device re-observes its own answer, which is reported as 'tx'.
 * The device sends immediately, so `delayUs` is ignored: the reply latency is the USB round trip.
 */
export class LegacyHidTransport extends TransportBase {
  readonly caps: TransportCaps = { canSniff: true, canSend: true, canReply: true, hasHwTimestamps: false };
  /** Raw payloads of 'info' reports (firmware / serial replies), for diagnostics. */
  readonly infoReports: Uint8Array[] = [];
  /**
   * Filled from the replies to the two init requests, which arrive in request order.
   * Verified on a DALI USB 24138923 (firmware 2.2, serial 00002FAC).
   */
  readonly deviceInfo: { firmware?: string; serial?: string } = {};
  /** Responses carrying a sequence number we did not send (ignored). */
  strayResponses = 0;

  private ownAnswers: { byte: number; at: number }[] = [];
  private stream?: DeviceStream;
  private offs: (() => void)[] = [];
  private seq = 1 + Math.floor(Math.random() * 255);
  private outstanding = new Map<number, Outstanding>();
  private readonly now: () => number;

  constructor(private readonly factory: StreamFactory, private readonly opts: LegacyHidOptions = {}) {
    super(opts.id ?? 'dali-usb', opts.label ?? 'DALI USB (Tridonic/Lunatone, HID)');
    this.now = opts.now ?? createHostClock();
  }

  async open(): Promise<void> {
    if (this._status === 'open') return;
    this.setStatus('opening');
    try {
      this.stream = await this.factory();
      this.offs.push(this.stream.onData((d) => this.onReport(d)));
      this.offs.push(this.stream.onClose((err) => this.onStreamClosed(err)));
      await this.stream.write(encodeInit(0x00)); // firmware version
      await this.stream.write(encodeInit(0x02)); // serial number
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
    if (this._status !== 'open' || !this.stream) throw new Error('Transport is not open');
    const bits = frame.bits ?? frame.data.length * 8;
    const seq = this.nextSeq();
    const report = encodeSend(seq, bits, frame.data, !!frame.sendTwice); // throws on unsupported length
    const timer = setTimeout(() => this.outstanding.delete(seq), this.opts.echoTimeoutMs ?? 500);
    this.outstanding.set(seq, { echoesLeft: frame.sendTwice ? 2 : 1, timer });
    try {
      await this.stream.write(report);
    } catch (e) {
      clearTimeout(timer);
      this.outstanding.delete(seq);
      throw e;
    }
  }

  async sendBackward(byte: number, _delayUs?: number): Promise<void> {
    if (this._status !== 'open' || !this.stream) throw new Error('Transport is not open');
    const report = encodeAnswer(byte);
    this.ownAnswers.push({ byte, at: this.now() });
    await this.stream.write(report);
  }

  // ---- internals ----------------------------------------------------------------------

  private nextSeq(): number {
    this.seq = this.seq >= 255 ? 1 : this.seq + 1; // 0 is reserved
    return this.seq;
  }

  private onReport(raw: Uint8Array): void {
    let r: Report;
    try { r = decodeReport(raw); } catch { return; }
    const ts = this.now();
    const make = (dir: 'rx' | 'tx', bits: number, data: Uint8Array): BusFrame => ({
      ts, dir, kind: bits === 8 ? 'backward' : 'forward', bits, data, source: this.id
    });
    const err = (e: FrameError): BusFrame => ({
      ts, dir: 'rx', kind: 'error', bits: 0, data: new Uint8Array(0), error: e, source: this.id
    });

    if (r.kind === 'info') {
      this.infoReports.push(raw.slice());
      if (this.infoReports.length === 1) this.deviceInfo.firmware = `${raw[3]}.${raw[4]}`;
      else if (this.infoReports.length === 2) {
        this.deviceInfo.serial = Array.from(raw.slice(1, 5), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      }
      return;
    }

    if (r.type === 'status') {
      const s = reportStatus(r);
      if (s === STATUS.FRAMING_ERROR || s === STATUS.CHECKSUM) this.emitFrame(err('framing'));
      else if (s === STATUS.SHORTED) this.emitFrame(err('bus-fault'));
      return;
    }
    const f = reportFrame(r);

    if (r.kind === 'observed') {
      if (f?.bits === 8) {
        // the device hears its own answer; label it as ours
        const i = this.ownAnswers.findIndex((a) => a.byte === f.data[0] && ts - a.at < 200_000);
        this.ownAnswers = this.ownAnswers.filter((a) => ts - a.at < 200_000);
        if (i >= 0) { this.ownAnswers.splice(i, 1); this.emitFrame(make('tx', 8, f.data)); return; }
      }
      if (f) this.emitFrame(make('rx', f.bits, f.data));
      return;
    }
    if (r.kind === 'response') {
      const o = this.outstanding.get(r.seq);
      if (!o) { this.strayResponses++; return; }
      if (!f) { this.finish(r.seq); return; }                       // 0x71: no answer
      if (f.bits === 8) { this.emitFrame(make('rx', 8, f.data)); this.finish(r.seq); return; } // answer
      // echo of the frame we sent (twice for send-twice). The entry stays until the answer,
      // a 'no frame' report or the timeout, so a reply to this query is not mistaken for a stray.
      this.emitFrame(make('tx', f.bits, f.data));
      o.echoesLeft--;
    }
  }

  private finish(seq: number): void {
    const o = this.outstanding.get(seq);
    if (!o) return;
    clearTimeout(o.timer);
    this.outstanding.delete(seq);
  }

  private onStreamClosed(err?: Error): void {
    if (this._status === 'closed') return;
    void this.teardown().then(() => this.setStatus('error', err ?? new Error('Device disconnected')));
  }

  private async teardown(): Promise<void> {
    this.offs.forEach((o) => o());
    this.offs = [];
    for (const o of this.outstanding.values()) clearTimeout(o.timer);
    this.outstanding.clear();
    const s = this.stream;
    this.stream = undefined;
    if (s) { try { await s.close(); } catch { /* already gone */ } }
  }
}
