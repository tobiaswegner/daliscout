import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BusFrame } from '@dali-scout/core';
import {
  LegacyHidTransport, REPORT_SIZE, encodeAnswer, decodeReport, encodeInit, encodeSend, reportFrame, type DeviceStream
} from '../src/index.js';

afterEach(() => vi.useRealTimers());

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join(' ');

/** Build a device->host report: kind, type, 4 frame bytes, interval, seq. */
const report = (kind: number, type: number, frame: number[] = [0, 0, 0, 0], seq = 0, interval = 0) => {
  const r = new Uint8Array(REPORT_SIZE);
  r[0] = kind; r[1] = type; r.set(frame, 2); r[6] = interval >> 8; r[7] = interval & 0xff; r[8] = seq;
  return r;
};

describe('legacy HID codec', () => {
  it('encodes a 16-bit send like python-dali (cmd 0x12, seq, flags, mode 3, right-aligned frame)', () => {
    const r = encodeSend(7, 16, Uint8Array.of(0xff, 0x90), false);
    expect(r).toHaveLength(64);
    expect(hex(r.slice(0, 12))).toBe('12 07 00 03 00 00 ff 90 00 00 00 00');
  });
  it('send twice sets flag 0x20; 24-bit uses mode 6', () => {
    expect(encodeSend(1, 16, Uint8Array.of(1, 2), true)[2]).toBe(0x20);
    const r = encodeSend(1, 24, Uint8Array.of(1, 2, 3), false);
    expect(hex(r.slice(0, 8))).toBe('12 01 00 06 00 01 02 03');
  });
  it('rejects unsupported sizes and sequence numbers', () => {
    expect(() => encodeSend(1, 8, Uint8Array.of(1), false)).toThrow(RangeError);
    expect(() => encodeSend(0, 16, Uint8Array.of(1, 2), false)).toThrow(RangeError);
    expect(() => encodeSend(256, 16, Uint8Array.of(1, 2), false)).toThrow(RangeError);
  });
  it('answer report carries the byte at index 1', () => {
    expect(hex(encodeAnswer(0x5a).slice(0, 4))).toBe('15 5a 00 00');
    expect(() => encodeAnswer(256)).toThrow(RangeError);
  });
  it('init reports', () => {
    expect(hex(encodeInit(0x00).slice(0, 3))).toBe('01 00 00');
    expect(hex(encodeInit(0x02).slice(0, 3))).toBe('01 02 00');
  });
  it('decodes reports and extracts frames', () => {
    const r = decodeReport(report(0x11, 0x73, [0, 0, 0x0b, 0xa0], 0, 0x0123));
    expect(r).toMatchObject({ kind: 'observed', type: 'dali16', interval: 0x123 });
    expect(reportFrame(r)).toEqual({ bits: 16, data: Uint8Array.of(0x0b, 0xa0) });
    expect(reportFrame(decodeReport(report(0x12, 0x72, [0, 0, 0, 0xfe])))).toEqual({ bits: 8, data: Uint8Array.of(0xfe) });
    expect(reportFrame(decodeReport(report(0x11, 0x76, [0, 1, 2, 3])))).toEqual({ bits: 24, data: Uint8Array.of(1, 2, 3) });
    expect(reportFrame(decodeReport(report(0x12, 0x71)))).toBeUndefined();
    expect(decodeReport(report(0x55, 0x99)).kind).toBe('unknown');
    expect(() => decodeReport(new Uint8Array(3))).toThrow();
  });
});

class FakeHid implements DeviceStream {
  written: Uint8Array[] = [];
  private dataCb?: (d: Uint8Array) => void;
  private closeCb?: (e?: Error) => void;
  closed = false;
  async write(d: Uint8Array) { this.written.push(d); }
  onData(cb: (d: Uint8Array) => void) { this.dataCb = cb; return () => { this.dataCb = undefined; }; }
  onClose(cb: (e?: Error) => void) { this.closeCb = cb; return () => { this.closeCb = undefined; }; }
  async close() { this.closed = true; }
  emit(r: Uint8Array) { this.dataCb?.(r); }
  disconnect() { this.closeCb?.(new Error('unplugged')); }
  lastSeq() { return this.written[this.written.length - 1]![1]!; }
}

describe('LegacyHidTransport', () => {
  const setup = async () => {
    const dev = new FakeHid();
    let t = 0;
    const tr = new LegacyHidTransport(async () => dev, { now: () => (t += 1000) });
    const frames: BusFrame[] = [];
    tr.onFrame((f) => frames.push(f));
    await tr.open();
    return { dev, tr, frames };
  };
  const show = (f: BusFrame) => `${f.dir} ${f.bits} ${f.kind === 'error' ? f.error : hex(f.data)}`;

  it('initialises with firmware and serial requests', async () => {
    const { dev, tr } = await setup();
    expect(tr.status).toBe('open');
    expect(dev.written.map((w) => hex(w.slice(0, 2)))).toEqual(['01 00', '01 02']);
    expect(tr.caps).toMatchObject({ canSniff: true, canSend: true, canReply: true, hasHwTimestamps: false });
  });

  it('sends backward frames with 0x15 and reports the re-observed answer as tx (hardware probe)', async () => {
    const { dev, tr, frames } = await setup();
    await tr.sendBackward(0xfe);
    expect(hex(dev.written.at(-1)!.slice(0, 4))).toBe('15 fe 00 00');
    dev.emit(report(0x15, 0)); // device acknowledgement, ignored
    dev.emit(report(0x11, 0x72, [0, 0, 0, 0xfe], 0, 0x45db));
    dev.emit(report(0x11, 0x72, [0, 0, 0, 0xfe], 0, 5));   // a second one is not ours
    expect(frames.map(show)).toEqual(['tx 8 fe', 'rx 8 fe']);
  });

  it('reads firmware and serial from the init replies (captured from a real 24138923)', async () => {
    const { dev, tr, frames } = await setup();
    const pad = (b: number[]) => { const r = new Uint8Array(64); r.set(b); return r; };
    dev.emit(pad([0x01, 0x00, 0x20, 0x02, 0x02, 0x00]));  // firmware reply seen on hardware
    dev.emit(pad([0x01, 0x00, 0x00, 0x2f, 0xac, 0x00]));  // serial reply seen on hardware
    expect(tr.deviceInfo).toEqual({ firmware: '2.2', serial: '00002FAC' });
    expect(frames).toHaveLength(0);
  });

  it('reports observed bus traffic as rx frames', async () => {
    const { dev, frames } = await setup();
    dev.emit(report(0x11, 0x73, [0, 0, 0x0b, 0xa0]));
    dev.emit(report(0x11, 0x72, [0, 0, 0, 0xfe]));
    dev.emit(report(0x11, 0x76, [0, 1, 2, 3]));
    expect(frames.map(show)).toEqual(['rx 16 0b a0', 'rx 8 fe', 'rx 24 01 02 03']);
    expect(frames[1]!.kind).toBe('backward');
    expect(frames[1]!.ts).toBeGreaterThan(frames[0]!.ts);
  });

  it('shows our frame as tx when the device echoes it, then the answer as rx', async () => {
    const { dev, tr, frames } = await setup();
    await tr.send({ data: Uint8Array.of(0x0b, 0xa0), expectReply: true });
    const seq = dev.lastSeq();
    expect(frames).toHaveLength(0); // nothing is claimed to be on the bus before the device confirms
    dev.emit(report(0x12, 0x73, [0, 0, 0x0b, 0xa0], seq));
    dev.emit(report(0x12, 0x72, [0, 0, 0, 0xfe], seq)); // regression: answer after echo must not be dropped
    expect(frames.map(show)).toEqual(['tx 16 0b a0', 'rx 8 fe']);
    expect(tr.strayResponses).toBe(0);
  });

  it('send twice yields two echoes; "no frame" ends the exchange', async () => {
    const { dev, tr, frames } = await setup();
    await tr.send({ data: Uint8Array.of(0xff, 0x20), sendTwice: true });
    const seq = dev.lastSeq();
    expect(dev.written.at(-1)![2]).toBe(0x20);
    dev.emit(report(0x12, 0x73, [0, 0, 0xff, 0x20], seq));
    dev.emit(report(0x12, 0x73, [0, 0, 0xff, 0x20], seq));
    dev.emit(report(0x12, 0x71, [0, 0, 0, 0], seq));
    expect(frames.map(show)).toEqual(['tx 16 ff 20', 'tx 16 ff 20']);
    dev.emit(report(0x12, 0x72, [0, 0, 0, 0x11], seq)); // late: entry is gone
    expect(tr.strayResponses).toBe(1);
  });

  it('ignores responses to commands we did not send, and info reports', async () => {
    const { dev, tr, frames } = await setup();
    dev.emit(report(0x12, 0x73, [0, 0, 1, 2], 99));
    dev.emit(report(0x01, 0x77, [0, 3, 4, 5]));
    expect(frames).toHaveLength(0);
    expect(tr.strayResponses).toBe(1);
    expect(tr.infoReports).toHaveLength(1);
  });

  it('maps status reports to bus errors', async () => {
    const { dev, frames } = await setup();
    dev.emit(report(0x11, 0x77, [0, 0, 0, 3])); // framing error
    dev.emit(report(0x11, 0x77, [0, 0, 0, 2])); // shorted
    dev.emit(report(0x11, 0x77, [0, 0, 0, 4])); // OK -> nothing
    expect(frames.map(show)).toEqual(['rx 0 framing', 'rx 0 bus-fault']);
  });

  it('sequence numbers skip 0 and wrap', async () => {
    const { dev, tr } = await setup();
    const seen = new Set<number>();
    for (let i = 0; i < 600; i++) {
      await tr.send({ data: Uint8Array.of(1, 2) });
      seen.add(dev.lastSeq());
    }
    expect(seen.has(0)).toBe(false);
    expect(seen.size).toBe(255);
  });

  it('refuses unsupported frames and sends while closed', async () => {
    const { tr } = await setup();
    await expect(tr.send({ data: Uint8Array.of(1), bits: 8 })).rejects.toThrow(RangeError);
    await tr.close();
    await expect(tr.send({ data: Uint8Array.of(1, 2) })).rejects.toThrow(/not open/);
  });

  it('drops an unconfirmed send after the echo timeout', async () => {
    vi.useFakeTimers();
    const dev = new FakeHid();
    const tr = new LegacyHidTransport(async () => dev, { echoTimeoutMs: 100 });
    await tr.open();
    await tr.send({ data: Uint8Array.of(1, 2) });
    const seq = dev.lastSeq();
    await vi.advanceTimersByTimeAsync(101);
    dev.emit(report(0x12, 0x73, [0, 0, 1, 2], seq));
    expect(tr.strayResponses).toBe(1);
  });

  it('reports a disconnect', async () => {
    const { dev, tr } = await setup();
    const seen: string[] = [];
    tr.onStatus((s) => seen.push(s));
    dev.disconnect();
    await vi.waitFor(() => expect(seen).toContain('error'));
  });
});
