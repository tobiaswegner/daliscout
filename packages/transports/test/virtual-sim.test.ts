import { describe, expect, it } from 'vitest';
import {
  Simulation, SimClock, commissionBus, frameDurationUs, toHex, type BusFrame, type CommissioningIo
} from '@dali-scout/core';
import { VirtualBus, attachSimulation } from '../src/index.js';

const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

async function rig(opts: { wireTiming?: boolean; canReply?: boolean; gears?: number; seed?: number } = {}) {
  let host = 0;
  const bus = new VirtualBus(() => host, { wireTiming: opts.wireTiming });
  const console_ = bus.createEndpoint('console');
  const monitor = bus.createEndpoint('monitor', { canSend: false });
  const simEp = bus.createEndpoint('sim', { canSend: false, canReply: opts.canReply ?? true });
  const sim = new Simulation({ rng: seeded(opts.seed ?? 1) });
  sim.addGears(opts.gears ?? 3, {}, 0);
  const clock = new SimClock(() => host);
  const seen: BusFrame[] = [];
  monitor.onFrame((f) => seen.push(f));
  await Promise.all([console_.open(), monitor.open(), simEp.open()]);
  attachSimulation(simEp, sim, { simTime: () => clock.now() });
  return { bus, console_, monitor, sim, seen, advance: (us: number) => { host += us; } };
}

const show = (f: BusFrame) => `${f.dir}:${f.source}:${f.kind === 'error' ? f.error : toHex(f.data)}`;

describe('VirtualBus ordering', () => {
  it('a reply sent while a frame is being delivered never overtakes it', async () => {
    const r = await rig();
    await r.console_.send({ data: Uint8Array.of(0x01, 0xa0) });   // QUERY ACTUAL LEVEL, short address 0... wait: 0x01 = short 0
    expect(r.seen.map(show)).toEqual(['rx:console:01 A0', 'rx:sim:FE']);
  });
  it('every endpoint sees the same order', async () => {
    const r = await rig();
    const consoleSeen: BusFrame[] = [];
    r.console_.onFrame((f) => consoleSeen.push(f));
    await r.console_.send({ data: Uint8Array.of(0x01, 0xa0) });
    expect(consoleSeen.map(show)).toEqual(['tx:console:01 A0', 'rx:sim:FE']);
  });
});

describe('wire timing', () => {
  it('forward frames occupy the bus and keep the 9.17 ms guard', async () => {
    const r = await rig({ wireTiming: true });
    await r.console_.send({ data: Uint8Array.of(0xff, 0x00) });
    await r.console_.send({ data: Uint8Array.of(0xff, 0x00) });
    const [a, b] = r.seen;
    expect(a!.ts).toBe(0);
    expect(b!.ts).toBeCloseTo(frameDurationUs(16) + 9_170, 0);
  });
  it('an answer follows its query by the reply delay, then the guard applies', async () => {
    const r = await rig({ wireTiming: true });
    await r.console_.send({ data: Uint8Array.of(0x01, 0xa0) });
    await r.console_.send({ data: Uint8Array.of(0xff, 0x00) });
    const [q, a, next] = r.seen;
    expect(a!.ts - (q!.ts + frameDurationUs(16))).toBeCloseTo(6_000, 0);
    expect(next!.ts).toBeCloseTo(a!.ts + frameDurationUs(8) + 9_170, 0);
  });
  it('never lets frames overlap, even when sent back to back', async () => {
    const r = await rig({ wireTiming: true, gears: 8, seed: 5 });
    const io: CommissioningIo = {
      send: async (f, twice) => { await r.console_.send({ data: Uint8Array.from(f), sendTwice: twice }); },
      query: async (f) => {
        const before = r.seen.length;
        await r.console_.send({ data: Uint8Array.from(f), expectReply: true });
        const reply = r.seen.slice(before).find((x) => x.kind === 'backward' || x.kind === 'error');
        return reply ? (reply.kind === 'error' ? 255 : reply.data[0]!) : null;
      }
    };
    const res = await commissionBus(io, { all: true });
    expect(res.assigned).toBe(8);
    expect(new Set(r.sim.gears.map((g) => g.s.shortAddress)).size).toBe(8);
    for (let i = 1; i < r.seen.length; i++) {
      const prev = r.seen[i - 1]!, cur = r.seen[i]!;
      expect(cur.ts).toBeGreaterThanOrEqual(prev.ts + (prev.kind === 'error' ? 0 : Math.round(frameDurationUs(prev.bits))));
      expect(Number.isInteger(cur.ts)).toBe(true);
    }
  });
  it('without wire timing frames carry host time', async () => {
    const r = await rig();
    r.advance(1234);
    await r.console_.send({ data: Uint8Array.of(0xff, 0x00) });
    expect(r.seen[0]!.ts).toBe(1234);
  });
});

describe('attachSimulation', () => {
  it('controls gears and answers queries over the bus', async () => {
    const r = await rig({ gears: 3 });
    await r.console_.send({ data: Uint8Array.of(0x02, 0x64) });          // DAPC 100 -> short 1
    expect(r.sim.gears.map((g) => g.s.actualLevel)).toEqual([254, 100, 254]);
    r.seen.length = 0;
    await r.console_.send({ data: Uint8Array.of(0x03, 0xa0), expectReply: true });
    expect(r.seen.map(show)).toEqual(['rx:console:03 A0', 'rx:sim:64']);
    expect(r.seen[1]!.kind).toBe('backward');
  });
  it('different answers on one query produce a collision frame', async () => {
    const r = await rig({ gears: 2 });
    r.sim.gears[0]!.forceLevel(10);
    await r.console_.send({ data: Uint8Array.of(0xff, 0xa0) });         // broadcast query
    expect(r.seen.map(show)).toEqual(['rx:console:FF A0', 'rx:sim:collision']);
    r.sim.gears[0]!.forceLevel(254);
    r.seen.length = 0;
    await r.console_.send({ data: Uint8Array.of(0xff, 0xa0) });         // identical answers form a valid frame
    expect(r.seen.map(show)).toEqual(['rx:console:FF A0', 'rx:sim:FE']);
  });
  it('a query nobody answers stays silent', async () => {
    const r = await rig({ gears: 1 });
    await r.console_.send({ data: Uint8Array.of(0x7f, 0xa0) });
    expect(r.seen).toHaveLength(1);
  });
  it('twice-sent configuration commands work over the bus', async () => {
    const r = await rig({ gears: 1 });
    await r.console_.send({ data: Uint8Array.of(0xa3, 77) });
    await r.console_.send({ data: Uint8Array.of(0x01, 0x2d), sendTwice: true });  // SET POWER ON LEVEL
    expect(r.sim.gears[0]!.s.powerOnLevel).toBe(77);
  });
  it('without reply capability gears follow the traffic but stay silent', async () => {
    const r = await rig({ gears: 2, canReply: false });
    await r.console_.send({ data: Uint8Array.of(0xff, 0x28) });         // DAPC 40 broadcast... (S=1: opcode 0x28) -> not a DAPC
    await r.console_.send({ data: Uint8Array.of(0xfe, 0x28) });         // broadcast DAPC 40
    expect(r.sim.gears.map((g) => g.s.actualLevel)).toEqual([40, 40]);
    await r.console_.send({ data: Uint8Array.of(0xff, 0xa0) });
    expect(r.seen.filter((f) => f.kind === 'backward' || f.kind === 'error')).toHaveLength(0);
  });
  it('ignores backward frames and detaches cleanly', async () => {
    const r = await rig({ gears: 1 });
    const simEp = r.bus.createEndpoint('x', { canReply: true });
    await simEp.open();
    const off = attachSimulation(simEp, r.sim, { simTime: () => 0 });
    off();
    await r.console_.send({ data: Uint8Array.of(0xfe, 0x10) });
    expect(r.sim.gears[0]!.s.actualLevel).toBe(16);
  });
});
