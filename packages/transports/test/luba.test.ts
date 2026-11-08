import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BusFrame } from '@dali-scout/core';
import {
  Cmd, LubaParser, LubaTransport, TickClock, buildAddFrame, buildAutoAnswer, encodeMessage, frameBytes,
  parseAddFrameResponse, parseDescriptor, parseEvent, type DeviceStream
} from '../src/index.js';

afterEach(() => vi.useRealTimers());

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join(' ');

describe('LUBA framing', () => {
  it('encodes with sync, length and XOR checksum', () => {
    // CMD 0x34 LEN 3 DATA 00 03 FE -> 0x34^0x03^0x00^0x03^0xFE
    const m = encodeMessage(0x34, [0x00, 0x03, 0xfe]);
    expect(hex(m)).toBe('59 34 03 00 03 fe ' + (0x34 ^ 3 ^ 0 ^ 3 ^ 0xfe).toString(16).padStart(2, '0'));
    expect(hex(encodeMessage(40))).toBe('59 28 00 28');
  });

  it('parses split chunks, garbage and bad checksums', () => {
    const p = new LubaParser();
    const a = encodeMessage(49, [1, 2, 3]);
    const b = encodeMessage(41, [9]);
    const bad = Uint8Array.from(a); bad[bad.length - 1]! ^= 0xff;
    const stream = Uint8Array.from([0x00, 0x11, ...bad, ...a, ...b]);
    const got = [
      ...p.push(stream.slice(0, 5)), ...p.push(stream.slice(5, 11)), ...p.push(stream.slice(11))
    ];
    expect(got.map((m) => m.cmd)).toEqual([49, 41]);
    expect(Array.from(got[0]!.data)).toEqual([1, 2, 3]);
    expect(p.checksumErrors).toBe(1);
    expect(p.droppedBytes).toBeGreaterThan(0);
  });

  it('a payload containing 0x59 does not confuse the parser', () => {
    const p = new LubaParser();
    expect(p.push(encodeMessage(49, [0x59, 0x59, 0x00])).map((m) => Array.from(m.data))).toEqual([[0x59, 0x59, 0]]);
  });
});

describe('LUBA requests', () => {
  it('builds 16- and 24-bit frame commands (spec 2.1.2 / 2.1.3)', () => {
    // priority default 3, send twice -> mode 0x83; wait for response -> 0x43
    expect(hex(buildAddFrame({ data: Uint8Array.of(0xff, 0x20), sendTwice: true }))).toMatch(/^59 34 04 00 83 ff 20 /);
    expect(hex(buildAddFrame({ data: Uint8Array.of(0x01, 0xa0), waitForResponse: true, priority: 2 }))).toMatch(/^59 34 04 00 42 01 a0 /);
    expect(hex(buildAddFrame({ data: Uint8Array.of(1, 2, 3) }))).toMatch(/^59 36 05 00 03 01 02 03 /);
  });
  it('uses the generic command for other lengths, right-aligned big-endian', () => {
    expect(hex(buildAddFrame({ data: Uint8Array.of(0xab), bits: 8 }))).toMatch(/^59 32 07 00 08 03 00 00 00 ab /);
  });
  it('rejects bad input', () => {
    expect(() => buildAddFrame({ data: Uint8Array.of(1, 2), priority: 6 })).toThrow(RangeError);
    expect(() => buildAddFrame({ data: Uint8Array.of(1), bits: 16 })).toThrow(RangeError);
  });
  it('builds an auto answer (little-endian frame)', () => {
    // slot 1, 16 bits, frame 0x0BA0 -> LE a0 0b 00 00, answer 0xfe
    expect(hex(buildAutoAnswer(1, 16, Uint8Array.of(0x0b, 0xa0), 0xfe))).toMatch(/^59 52 07 00 50 a0 0b 00 00 fe /);
  });
  it('parses add-frame responses', () => {
    expect(parseAddFrameResponse(Uint8Array.of(7, 1))).toEqual({ ok: true, firstId: 7 });
    expect(parseAddFrameResponse(Uint8Array.of(4))).toEqual({ ok: false, error: 'send buffer full' });
  });
  it('parses the device descriptor', () => {
    const d = Uint8Array.from([1, 32, 100, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 10, 0x90]);
    expect(parseDescriptor(d)).toMatchObject({
      lines: 1, bufferSize: 32, tickUs: 100, protocolMajor: 1, protocolMinor: 10,
      hasBusPowerSupply: true, hasBusShort: true
    });
    expect(() => parseDescriptor(new Uint8Array(5))).toThrow();
  });
});

describe('LUBA events', () => {
  const ev = (status: number, ...rest: number[]) => Uint8Array.from([0x34, 0x12, 0x00, status, ...rest]);
  it('sent frame (type 0, info = bits)', () => {
    const r = parseEvent(ev(0x10, 5, 0, 0, 0xfe, 0x80), true, true);
    expect(r.tick).toBe(0x1234);
    expect(r.event).toEqual({ type: 'sent', id: 5, bits: 16, frame: Uint8Array.of(0xfe, 0x80) });
  });
  it('response variants (type 1)', () => {
    expect(parseEvent(ev(0x40, 3), true, true).event).toEqual({ type: 'response', id: 3, answer: 'none' });
    expect(parseEvent(ev(0x48, 3, 0xfe), true, true).event).toEqual({ type: 'response', id: 3, answer: 0xfe });
    expect(parseEvent(ev(0x7f, 3, 255), true, true).event).toEqual({ type: 'response', id: 3, answer: 'collision' });
  });
  it('received frame and receive errors (type 2)', () => {
    expect(parseEvent(ev(0x90, 0, 0, 0x0b, 0xa0), true, true).event)
      .toEqual({ type: 'received', bits: 16, frame: Uint8Array.of(0x0b, 0xa0) });
    expect(parseEvent(ev(0x88, 0, 0, 0, 0x55), true, true).event)
      .toEqual({ type: 'received', bits: 8, frame: Uint8Array.of(0x55) });
    expect(parseEvent(ev(0xbf), true, true).event).toEqual({ type: 'receive-error', reason: 'framing' });
    expect(parseEvent(ev(0xbe), true, true).event).toEqual({ type: 'receive-error', reason: 'start-stop-only' });
  });
  it('bus events (type 3) and optional tick/line', () => {
    expect(parseEvent(Uint8Array.of(0xc0), false, false).event).toEqual({ type: 'bus', event: 'bus-error' });
    expect(parseEvent(Uint8Array.of(0xc2), false, false)).toEqual({ tick: undefined, line: undefined, event: { type: 'bus', event: 'bus-restored' } });
    expect(parseEvent(Uint8Array.of(7, 0xc2), false, true).line).toBe(7);
  });
  it('rejects truncated events', () => {
    expect(() => parseEvent(ev(0x10, 5, 0), true, true)).toThrow();
    expect(() => parseEvent(Uint8Array.of(), false, false)).toThrow();
  });
  it('frameBytes keeps the low bytes', () => {
    expect(hex(frameBytes(Uint8Array.of(0, 0xaa, 0xbb, 0xcc), 24))).toBe('aa bb cc');
  });
});

describe('TickClock', () => {
  it('unwraps the 16-bit tick and anchors at host time', () => {
    const c = new TickClock(100); // 100 µs per tick
    expect(c.stamp(65000, 1_000)).toBe(1_000);
    expect(c.stamp(65500, 51_000)).toBe(1_000 + 500 * 100);
    expect(c.stamp(100, 71_000)).toBe(1_000 + (500 + 136) * 100); // 65500 -> 100 wraps: +136 ticks
  });
  it('wrap arithmetic', () => {
    const c = new TickClock(1000);
    c.stamp(65535, 0);
    expect(c.stamp(1, 2000)).toBe(2000); // 65535 -> 1 is 2 ticks
  });
  it('resolves idle gaps longer than one wrap with host time', () => {
    const c = new TickClock(1000); // wrap = 65.536 s
    c.stamp(10, 0);
    // 200 s of silence, raw tick advanced by 200000 mod 65536 = 3392
    const ts = c.stamp((10 + 200_000) & 0xffff, 200_000_000);
    expect(ts).toBe(200_000_000);
  });
  it('falls back to host time without ticks', () => {
    expect(new TickClock(0).stamp(5, 123)).toBe(123);
    expect(new TickClock(100).stamp(undefined, 456)).toBe(456);
  });
});

// ---- fake device -------------------------------------------------------------------------

class FakeLuba implements DeviceStream {
  written: Uint8Array[] = [];
  private dataCb?: (d: Uint8Array) => void;
  private closeCb?: (e?: Error) => void;
  sendResponse: Uint8Array | null = Uint8Array.of(9, 1);
  settings = Uint8Array.of(0x00, 0xff, 0x00); // all events disabled by default
  respond = true;
  parser = new LubaParser();

  async write(data: Uint8Array) {
    this.written.push(data);
    for (const m of this.parser.push(data)) {
      if (!this.respond) continue;
      if (m.cmd === Cmd.QUERY_DEVICE_DESCRIPTOR) {
        this.emit(encodeMessage(41, [1, 32, 100, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 10, 0]));
      } else if (m.cmd === Cmd.SETTINGS) {
        if (m.data.length === 3) this.settings = Uint8Array.from(m.data);
        this.emit(encodeMessage(43, this.settings));
      } else if ([52, 54, 50].includes(m.cmd) && this.sendResponse) {
        this.emit(encodeMessage(m.cmd + 1, this.sendResponse));
      }
    }
  }
  onData(cb: (d: Uint8Array) => void) { this.dataCb = cb; return () => { this.dataCb = undefined; }; }
  onClose(cb: (e?: Error) => void) { this.closeCb = cb; return () => { this.closeCb = undefined; }; }
  async close() { this.closed = true; }
  closed = false;
  emit(b: Uint8Array) { this.dataCb?.(b); }
  disconnect() { this.closeCb?.(new Error('unplugged')); }
  event(tick: number, status: number, ...rest: number[]) {
    this.emit(encodeMessage(49, [tick & 0xff, tick >> 8, 0, status, ...rest]));
  }
}

describe('LubaTransport', () => {
  const setup = async () => {
    const dev = new FakeLuba();
    let t = 0;
    const tr = new LubaTransport(async () => dev, { now: () => (t += 10) });
    const frames: BusFrame[] = [];
    tr.onFrame((f) => frames.push(f));
    await tr.open();
    return { dev, tr, frames };
  };

  it('negotiates descriptor and enables all events, preserving other settings', async () => {
    const dev = new FakeLuba();
    dev.settings = Uint8Array.of(0x80, 0xff, 0x80);
    const tr = new LubaTransport(async () => dev);
    await tr.open();
    expect(tr.status).toBe('open');
    expect(tr.descriptor?.tickUs).toBe(100);
    expect(Array.from(dev.settings)).toEqual([0x80, 0x00, 0x80]); // only eventFilter changed
    expect(tr.caps).toMatchObject({ canSniff: true, canSend: true, canReply: false, hasHwTimestamps: true });
  });

  it('maps events to bus frames with device time', async () => {
    const { dev, frames } = await setup();
    dev.event(1000, 0x90, 0, 0, 0x0b, 0xa0);          // received 16 bit
    dev.event(1000 + 90, 0x88, 0, 0, 0, 0xfe);         // received 8 bit (answer from gear)
    dev.event(1000 + 500, 0x10, 4, 0, 0, 0xfe, 0x80);  // we sent FE 80
    expect(frames.map((f) => [f.dir, f.kind, f.bits, hex(f.data)])).toEqual([
      ['rx', 'forward', 16, '0b a0'], ['rx', 'backward', 8, 'fe'], ['tx', 'forward', 16, 'fe 80']
    ]);
    expect(frames[1]!.ts - frames[0]!.ts).toBe(90 * 100);
    expect(frames[2]!.ts - frames[0]!.ts).toBe(500 * 100);
  });

  it('answers to our own frames, collisions and bus faults', async () => {
    const { dev, frames } = await setup();
    dev.event(1, 0x48, 4, 0x55);   // answer 0x55
    dev.event(2, 0x40, 5);          // no answer -> nothing
    dev.event(3, 0x7f, 6, 255);     // collision
    dev.event(4, 0xbf);             // framing error
    dev.event(5, 0xc0);             // bus error
    dev.event(6, 0xc2);             // bus restored
    dev.event(7, 0xc3);             // buffer full -> nothing
    expect(frames.map((f) => f.kind === 'error' ? f.error : hex(f.data))).toEqual([
      '55', 'collision', 'framing', 'bus-fault', 'bus-restored'
    ]);
  });

  it('sends frames and reports interface errors', async () => {
    const { dev, tr } = await setup();
    await tr.send({ data: Uint8Array.of(0x0b, 0xa0), expectReply: true });
    const last = dev.written[dev.written.length - 1]!;
    expect(hex(last)).toMatch(/^59 34 04 00 43 0b a0 /); // prio 3 + wait-for-response
    dev.sendResponse = Uint8Array.of(4);
    await expect(tr.send({ data: Uint8Array.of(1, 2) })).rejects.toThrow(/send buffer full/);
  });

  it('times out when the device does not answer, and cleans up', async () => {
    const dev = new FakeLuba();
    dev.respond = false;
    const tr = new LubaTransport(async () => dev, { timeoutMs: 20 });
    const states: string[] = [];
    tr.onStatus((s) => states.push(s));
    await expect(tr.open()).rejects.toThrow(/No response/);
    expect(states).toEqual(['opening', 'error']);
    expect(dev.closed).toBe(true);
  });

  it('reports a disconnect', async () => {
    const { dev, tr } = await setup();
    const seen: string[] = [];
    tr.onStatus((s) => seen.push(s));
    dev.disconnect();
    await vi.waitFor(() => expect(seen).toContain('error'));
    await expect(tr.send({ data: Uint8Array.of(1, 2) })).rejects.toThrow(/not open/);
  });

  it('ignores corrupt events without breaking the stream', async () => {
    const { dev, frames } = await setup();
    dev.emit(encodeMessage(49, [0, 0, 0]));            // status byte missing data
    dev.event(1, 0x90, 0, 0, 0x0b, 0xa0);
    expect(frames).toHaveLength(1);
  });
});
