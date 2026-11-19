import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimHost } from '../src/main/sim-host';
import { SimStore, cleanStateName } from '../src/main/sim-store';
import { SourceManager } from '../src/main/source';
import type { SimState } from '../src/shared';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dali-scout-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const host = async (store?: SimStore) => {
  const states: SimState[] = [];
  const h = new SimHost((s) => states.push(s), undefined, store);
  await h.start();
  return { h, last: () => states.at(-1)! };
};

describe('SimStore', () => {
  it('cleans names', () => {
    expect(cleanStateName('  my state ')).toBe('my state');
    expect(cleanStateName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(cleanStateName('.hidden')).toBe('hidden');
    expect(() => cleanStateName('   ')).toThrow(/name/);
  });

  it('saves, lists, loads and removes named states', async () => {
    const store = new SimStore(dir);
    const { h } = await host(store);
    await h.command({ type: 'saveState', name: 'one' });
    await h.command({ type: 'clear' });
    await h.command({ type: 'saveState', name: 'empty' });
    expect(store.list().map((s) => `${s.name}:${s.gears}`).sort()).toEqual(['empty:0', 'one:8']);
    expect(store.load('one').gears).toHaveLength(8);
    await h.command({ type: 'deleteState', name: 'one' });
    expect(store.list().map((s) => s.name)).toEqual(['empty']);
    expect(() => store.load('one')).toThrow(/No saved state/);
    h.dispose();
  });
});

describe('automatic save and restore', () => {
  it('restores the gears of the last session, with their registers', async () => {
    const store = new SimStore(dir);
    const a = await host(store);
    await a.h.command({ type: 'setLevel', id: 2, level: 99 });
    await a.h.command({ type: 'rename', id: 2, name: 'Kitchen' });
    await a.h.command({ type: 'fault', id: 3, patch: { lampFailure: true } });
    a.h.sim.gear(1)!.s.groups = 0b101;
    a.h.dispose();                                   // dispose flushes the autosave

    const b = await host(store);
    const g = b.last().gears;
    expect(g).toHaveLength(8);
    expect(g[2]!.state).toMatchObject({ name: 'Kitchen', actualLevel: 99, shortAddress: 2 });
    expect(g[3]!.state.faults.lampFailure).toBe(true);
    expect(g[1]!.state.groups).toBe(5);
    expect(b.last().persist).toMatchObject({ auto: true, restored: expect.stringContaining('8 gears') });
    b.h.dispose();
  });

  it('starts with the defaults when nothing was saved, or when remembering is off', async () => {
    const store = new SimStore(dir);
    const a = await host(store);
    expect(a.last().gears).toHaveLength(8);
    expect(a.last().persist?.restored).toBeUndefined();
    await a.h.command({ type: 'clear' });
    await a.h.command({ type: 'autoState', value: false });
    a.h.dispose();
    expect(store.autoEnabled()).toBe(false);
    const b = await host(store);
    expect(b.last().gears).toHaveLength(8);          // not the empty saved state
    expect(b.last().persist?.auto).toBe(false);
    b.h.dispose();
  });

  it('survives a damaged autosave: defaults, an error message, and the file is kept', async () => {
    writeFileSync(join(dir, 'autosave.json'), '{"format":"dali-scout-sim","version":1,"simNowUs":0,"gears":[{"id":0,"state":{}}]}');
    const { h, last } = await host(new SimStore(dir));
    expect(last().gears).toHaveLength(8);
    expect(last().persist?.error).toMatch(/could not be restored.*autosave\.bad\.json/);
    expect(readdirSync(dir)).toContain('autosave.bad.json');
    h.dispose();
  });

  it('writes nothing without a store', async () => {
    const { h, last } = await host();
    expect(last().persist).toBeUndefined();
    expect((await h.command({ type: 'saveState', name: 'x' })).ok).toBe(false);
    h.dispose();
  });
});

describe('manual save and restore', () => {
  it('restores a saved 65-gear state (colour gear included) over later changes', async () => {
    const store = new SimStore(dir);
    const { h, last } = await host(store);
    await h.command({ type: 'scenario', name: 'mixed65' });
    const id5 = last().gears[5]!.id;
    expect((await h.command({ type: 'setLevel', id: id5, level: 10 })).ok).toBe(true);
    expect((await h.command({ type: 'saveState', name: 'demo' })).ok).toBe(true);
    expect(last().persist?.saved.map((s) => s.name)).toEqual(['demo']);

    await h.command({ type: 'clear' });
    expect(last().gears).toHaveLength(0);
    const r = await h.command({ type: 'restoreState', name: 'demo' });
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining('65 gears') });
    expect(last().gears).toHaveLength(65);
    expect(last().gears[5]!.state.actualLevel).toBe(10);
    expect(last().gears.some((g) => g.state.dt8)).toBe(true);
    h.dispose();
  });

  it('reports a missing state without touching the gears', async () => {
    const { h, last } = await host(new SimStore(dir));
    const r = await h.command({ type: 'restoreState', name: 'nothing' });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/No saved state/) });
    expect(last().gears).toHaveLength(8);
    h.dispose();
  });

  it('exports to text and imports it again', async () => {
    const a = await host(new SimStore(dir));
    await a.h.command({ type: 'setLevel', id: 0, level: 33 });
    const text = JSON.stringify(a.h.exportState());
    await a.h.command({ type: 'clear' });
    expect(a.h.importState(text)).toMatch(/8 gears/);
    expect(a.last().gears[0]!.state.actualLevel).toBe(33);
    expect(() => a.h.importState('{"nope":1}')).toThrow(/Not a DALI Scout state file/);
    a.h.dispose();
  });

  it('SourceManager imports a file into the running simulator and refuses without one', async () => {
    const win: any = { webContents: { send: () => undefined } };
    const mgr = new SourceManager(() => win, new SimStore(dir));
    expect(mgr.importSimState('{}')).toMatchObject({ ok: false });
    expect(mgr.exportSimState()).toBeNull();
    await mgr.startVirtual();
    const text = mgr.exportSimState()!;
    expect(JSON.parse(text).gears).toHaveLength(8);
    expect(mgr.importSimState(text)).toMatchObject({ ok: true });
    expect(mgr.importSimState('garbage')).toMatchObject({ ok: false, error: expect.stringMatching(/invalid JSON/) });
    await mgr.stop();
    expect(JSON.parse(readFileSync(join(dir, 'autosave.json'), 'utf8')).gears).toHaveLength(8);
  });
});
