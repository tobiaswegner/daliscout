import { describe, expect, it } from 'vitest';
import { makeFrame, type BusFrame } from '@dali-scout/core';
import { TransportBase, type TransportCaps } from '@dali-scout/transports';
import { SourceManager } from '../src/main/source';
import { CH, type SimState, type SourceInfo } from '../src/shared';

const setup = () => {
  const sent: { ch: string; payload: any }[] = [];
  const win: any = { webContents: { send: (ch: string, payload: unknown) => sent.push({ ch, payload }) } };
  const mgr = new SourceManager(() => win);
  const sources = () => sent.filter((s) => s.ch === CH.source).map((s) => s.payload as SourceInfo);
  const frames = () => sent.filter((s) => s.ch === CH.frames).flatMap((s) => s.payload as BusFrame[]);
  const simStates = () => sent.filter((s) => s.ch === CH.simState).map((s) => s.payload as SimState);
  return { mgr, sent, sources, frames, simStates };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FailingTransport extends TransportBase {
  caps: TransportCaps = { canSniff: true, canSend: false, canReply: false, hasHwTimestamps: false };
  constructor() { super('bad', 'Bad device'); }
  async open() { throw new Error('Permission denied'); }
  async close() { /* nothing */ }
}

describe('SourceManager', () => {
  it('virtual bus: reports canSend, sends frames (twice) and batches them to the renderer', async () => {
    const { mgr, sources, frames, sent } = setup();
    await mgr.startVirtual();
    expect(sources().at(-1)).toMatchObject({ state: 'running', kind: 'virtual', canSend: true });

    expect(await mgr.send({ hex: 'FE 80', sendTwice: true, expectReply: false })).toEqual({ ok: true });
    await mgr.send({ hex: '0xFE, 0x00', sendTwice: false, expectReply: false });
    await wait(40);
    expect(frames().map((f) => `${f.dir} ${Array.from(f.data).map((b) => b.toString(16)).join('')}`))
      .toEqual(['tx fe80', 'tx fe80', 'tx fe0']);
    // three frames, one IPC message: batching works
    expect(sent.filter((s) => s.ch === CH.frames)).toHaveLength(1);
    await mgr.stop();
  });

  it('send errors are returned, not thrown', async () => {
    const { mgr } = setup();
    expect(await mgr.send({ hex: 'FF', sendTwice: false, expectReply: false })).toMatchObject({ ok: false, error: /cannot send/ });
    await mgr.startVirtual();
    expect(await mgr.send({ hex: 'F', sendTwice: false, expectReply: false })).toMatchObject({ ok: false, error: /Odd number/ });
    await mgr.stop();
  });

  it('replay sources cannot send and finish cleanly', async () => {
    const { mgr, sources, frames } = setup();
    await mgr.startReplay([makeFrame('0B A0', { ts: 0 }), makeFrame('FE', { ts: 1000 })], 'file.dscap');
    expect(sources().at(-1)).toMatchObject({ state: 'running', kind: 'replay', canSend: false });
    expect(await mgr.send({ hex: 'FF 00', sendTwice: false, expectReply: false })).toMatchObject({ ok: false });
    await wait(60);
    expect(frames()).toHaveLength(2);
    expect(sources().at(-1)).toMatchObject({ state: 'finished' });
  });

  it('a device that fails to open is reported as an error', async () => {
    const { mgr, sources } = setup();
    await mgr.attach(new FailingTransport(), 'Bad device', 'device');
    const last = sources().at(-1)!;
    expect(last).toMatchObject({ state: 'error', kind: 'device' });
    expect(last.error).toBe('Permission denied');
    expect(await mgr.send({ hex: 'FF 00', sendTwice: false, expectReply: false })).toMatchObject({ ok: false });
  });

  it('switching sources stops the previous one', async () => {
    const { mgr, sources } = setup();
    await mgr.startVirtual();
    await mgr.startReplay([makeFrame('0B A0', { ts: 0 })], 'x');
    expect(sources().filter((s) => s.state === 'running').map((s) => s.kind)).toEqual(['virtual', 'replay']);
    await mgr.stopAndReport();
    expect(sources().at(-1)).toMatchObject({ state: 'idle' });
  });
});

describe('SourceManager simulator', () => {
  const ok = { ok: true };

  it('the virtual bus starts with 8 addressed gears that answer queries', async () => {
    const { mgr, simStates, frames } = setup();
    await mgr.startVirtual();
    const st = simStates().at(-1)!;
    expect(st).toMatchObject({ active: true, maxGears: 65, speed: 1, paused: false });
    expect(st.gears.map((g) => g.state.shortAddress)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    await mgr.send({ hex: '07 A0', sendTwice: false, expectReply: true });   // short 3: QUERY ACTUAL LEVEL
    await wait(40);
    expect(frames().map((f) => `${f.dir} ${f.source} ${f.kind}`)).toEqual(['tx console forward', 'rx sim backward']);
    expect(frames()[1]!.data[0]).toBe(254);
    expect(frames()[1]!.ts).toBeGreaterThan(frames()[0]!.ts);   // wire timing: the answer comes later
    await mgr.stop();
    expect(simStates().at(-1)).toMatchObject({ active: false, gears: [] });
  });

  it('add / remove / clone / clear gears and enforce the limit', async () => {
    const { mgr, simStates } = setup();
    await mgr.startVirtual();
    expect(await mgr.simCommand({ type: 'clear' })).toMatchObject(ok);
    expect(await mgr.simCommand({ type: 'add', count: 3, addressed: true })).toMatchObject(ok);
    await wait(80);
    expect(simStates().at(-1)!.gears.map((g) => g.state.shortAddress)).toEqual([0, 1, 2]);
    expect(await mgr.simCommand({ type: 'add', count: 2, addressed: false })).toMatchObject(ok);

    const first = simStates().at(-1)!.gears[0]!.id;
    expect(await mgr.simCommand({ type: 'clone', id: first })).toMatchObject(ok);
    await wait(80);
    const gears = simStates().at(-1)!.gears;
    expect(gears).toHaveLength(6);
    expect(gears.at(-1)!.state.shortAddress).toBeNull();   // a clone never duplicates a short address
    expect(gears.at(-1)!.state.name).toContain('copy');

    expect(await mgr.simCommand({ type: 'remove', id: first })).toMatchObject(ok);
    expect(await mgr.simCommand({ type: 'remove', id: 9999 })).toMatchObject({ ok: false, error: /No gear/ });
    expect(await mgr.simCommand({ type: 'add', count: 61, addressed: false })).toMatchObject({ ok: false, error: /At most 65/ });
    expect(await mgr.simCommand({ type: 'add', count: 61, addressed: false })).toMatchObject({ ok: false });
    await mgr.stop();
  });

  it('manual level, faults, speed and pause are applied and published', async () => {
    const { mgr, simStates } = setup();
    await mgr.startVirtual();
    const id = simStates().at(-1)!.gears[2]!.id;
    await mgr.simCommand({ type: 'setLevel', id, level: 40 });
    await mgr.simCommand({ type: 'fault', id, patch: { lampFailure: true } });
    await mgr.simCommand({ type: 'speed', value: 4 });
    await mgr.simCommand({ type: 'pause', value: true });
    await wait(80);
    const st = simStates().at(-1)!;
    expect(st.gears.find((g) => g.id === id)!.state).toMatchObject({ actualLevel: 40, faults: { lampFailure: true } });
    expect(st).toMatchObject({ speed: 4, paused: true });
    expect(await mgr.simCommand({ type: 'speed', value: 0 })).toMatchObject({ ok: false });
    await mgr.stop();
  });

  it('commissions unaddressed gears over the bus; the monitor sees every frame', async () => {
    const { mgr, simStates, frames } = setup();
    await mgr.startVirtual();
    await mgr.simCommand({ type: 'clear' });
    await mgr.simCommand({ type: 'add', count: 12, addressed: false });
    const res = await mgr.simCommand({ type: 'commission', all: false });
    expect(res).toMatchObject({ ok: true, message: /Commissioned 12 gears/ });
    await wait(80);
    const addrs = simStates().at(-1)!.gears.map((g) => g.state.shortAddress);
    expect(new Set(addrs).size).toBe(12);
    expect(Math.max(...(addrs as number[]))).toBe(11);
    expect(simStates().some((s) => s.busy === 'Commissioning…')).toBe(true);
    expect(simStates().at(-1)!.busy).toBeUndefined();
    const f = frames();
    expect(f.length).toBeGreaterThan(100);
    expect(f.some((x) => x.kind === 'backward')).toBe(true);
    for (let i = 1; i < f.length; i++) expect(f[i]!.ts).toBeGreaterThanOrEqual(f[i - 1]!.ts);
    await mgr.stop();
  }, 20_000);

  it('adds DT0 and DT8 gear and clones their configuration', async () => {
    const { mgr, simStates } = setup();
    await mgr.startVirtual();
    await mgr.simCommand({ type: 'clear' });
    await mgr.simCommand({ type: 'add', count: 1, addressed: true, gearType: 'rgbw' });
    await mgr.simCommand({ type: 'add', count: 1, addressed: true, gearType: 'dt0' });
    await mgr.simCommand({ type: 'add', count: 1, addressed: true, gearType: 'tc' });
    await wait(80);
    const g = simStates().at(-1)!.gears;
    expect(g.map((x) => x.state.deviceTypes)).toEqual([[8], [0], [8]]);
    expect(g[0]!.state.dt8!.cfg.primaries).toBe(4);
    expect(g[1]!.state.dt0).toBeDefined();
    expect(g[2]!.state.dt8!.cfg.xy).toBe(false);
    await mgr.simCommand({ type: 'clone', id: g[0]!.id });
    await wait(80);
    const clone = simStates().at(-1)!.gears.at(-1)!.state;
    expect(clone.dt8!.cfg.primaries).toBe(4);
    expect(clone.shortAddress).toBeNull();
    await mgr.stop();
  });

  it('the 65-gear demo: 64 addressed gears plus one unaddressed', async () => {
    const { mgr, simStates } = setup();
    await mgr.startVirtual();
    expect(await mgr.simCommand({ type: 'scenario', name: 'mixed65' })).toMatchObject({ ok: true, message: /65 gears/ });
    await wait(80);
    const gs = simStates().at(-1)!.gears;
    expect(gs).toHaveLength(65);
    expect(gs.filter((x) => x.state.dt8)).toHaveLength(45);
    expect(gs.filter((x) => x.state.dt0)).toHaveLength(10);
    expect(gs.filter((x) => x.state.shortAddress === null)).toHaveLength(1);
    await mgr.stop();
  });

  it('a colour sent from the console reaches the DT8 gear and the monitor shows it decoded', async () => {
    const { mgr, simStates, frames } = setup();
    await mgr.startVirtual();
    await mgr.simCommand({ type: 'clear' });
    await mgr.simCommand({ type: 'add', count: 2, addressed: true, gearType: 'rgb-ct' });
    for (const hex of ['A3 CB', 'C3 00', 'C1 08', '01 E7', 'C1 08', '01 E2']) {
      await mgr.send({ hex, sendTwice: false, expectReply: false });
    }
    await wait(80);
    const gs = simStates().at(-1)!.gears;
    expect(gs[0]!.state.dt8!.actual.tc).toBe(203);
    expect(gs[1]!.state.dt8!.actual.tc).toBe(250);       // other address untouched
    expect(frames().some((f) => f.data[1] === 0xe7)).toBe(true);
    await mgr.stop();
  });

  it('simulator commands need the virtual bus', async () => {
    const { mgr } = setup();
    expect(await mgr.simCommand({ type: 'clear' })).toMatchObject({ ok: false, error: /virtual bus/ });
  });
});
