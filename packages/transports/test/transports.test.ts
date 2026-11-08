import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFrame, type BusFrame } from '@dali-scout/core';
import { ReplayTransport, VirtualBus } from '../src/index.js';

afterEach(() => vi.useRealTimers());

describe('VirtualBus', () => {
  it('delivers frames to all endpoints, marking the sender tx', async () => {
    let t = 0;
    const bus = new VirtualBus(() => (t += 1000));
    const ctrl = bus.createEndpoint('ctrl');
    const mon = bus.createEndpoint('mon', { canSend: false });
    const gotCtrl: BusFrame[] = [], gotMon: BusFrame[] = [];
    ctrl.onFrame((f) => gotCtrl.push(f));
    mon.onFrame((f) => gotMon.push(f));
    await ctrl.open(); await mon.open();

    await ctrl.send({ data: Uint8Array.of(0xff, 0xa0) });
    expect(gotCtrl[0]!.dir).toBe('tx');
    expect(gotMon[0]!.dir).toBe('rx');
    expect(gotMon[0]!.source).toBe('ctrl');
    expect(gotMon[0]!.bits).toBe(16);
    await expect(mon.send({ data: Uint8Array.of(1, 2) })).rejects.toThrow(/not supported/);
  });

  it('sendTwice emits two frames; closed endpoints hear nothing', async () => {
    const bus = new VirtualBus(() => 0);
    const a = bus.createEndpoint('a'), b = bus.createEndpoint('b');
    const got: BusFrame[] = [];
    b.onFrame((f) => got.push(f));
    await a.open(); await b.open();
    await a.send({ data: Uint8Array.of(0xff, 0x20), sendTwice: true });
    expect(got).toHaveLength(2);
    await b.close();
    await a.send({ data: Uint8Array.of(0xff, 0x20) });
    expect(got).toHaveLength(2);
  });

  it('backward frames require canReply', async () => {
    const bus = new VirtualBus(() => 100);
    const noReply = bus.createEndpoint('x');
    expect(noReply.sendBackward).toBeUndefined();
    const gear = bus.createEndpoint('gear', { canReply: true });
    const mon = bus.createEndpoint('mon');
    const got: BusFrame[] = [];
    mon.onFrame((f) => got.push(f));
    await gear.open(); await mon.open();
    await gear.sendBackward!(0xfe, 3000);
    expect(got[0]).toMatchObject({ kind: 'backward', bits: 8, ts: 3100 });
  });
});

describe('ReplayTransport', () => {
  const frames = [
    makeFrame('FF A0', { ts: 0 }), makeFrame('FE', { ts: 5000 }), makeFrame('FF 00', { ts: 105000 })
  ];

  it('replays with original timing', async () => {
    vi.useFakeTimers();
    const r = new ReplayTransport(frames);
    const got: BusFrame[] = [];
    r.onFrame((f) => got.push(f));
    await r.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(got).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(99);
    expect(got).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toHaveLength(3);
    expect(got[0]!.source).toBe('replay');
    await vi.advanceTimersByTimeAsync(1);
    expect(r.status).toBe('closed');
  });

  it('honours speed and loop', async () => {
    vi.useFakeTimers();
    const r = new ReplayTransport(frames, { speed: 10, loop: true, maxGapMs: 50 });
    const got: BusFrame[] = [];
    r.onFrame((f) => got.push(f));
    await r.open();
    await vi.advanceTimersByTimeAsync(10.5); // 0 + 0.5 + 10 ms at 10x
    expect(got).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60);
    expect(got.length).toBeGreaterThan(3);
    await r.close();
  });

  it('cannot send', async () => {
    const r = new ReplayTransport(frames);
    await expect(r.send({ data: Uint8Array.of(1, 2) })).rejects.toThrow();
  });
});
