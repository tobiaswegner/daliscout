import { describe, expect, it } from 'vitest';
import { Simulation, makeFrame, parseSimState, type SimStateFile } from '../src/index.js';

const send = (sim: Simulation, hex: string, busUs: number, simUs: number) => {
  const f = makeFrame(hex);
  return sim.process(f.data, f.bits, { busUs, simUs });
};

const build = () => {
  const sim = new Simulation({ rng: () => 0.5 });
  sim.addGear({ shortAddress: 0 });
  sim.addGear({ shortAddress: 1, deviceTypes: [0] });
  sim.addGear({ shortAddress: 2, colour: 'rgb-ct' });
  sim.addGear({});                                   // unaddressed
  return sim;
};

describe('simulator state save / restore', () => {
  it('round-trips through JSON and gives identical snapshots', () => {
    const a = build();
    send(a, '01 A0', 0, 0);              // not a command, just traffic
    a.gear(0)!.forceLevel(120);
    a.gear(2)!.setFault({ lampFailure: true });
    const text = JSON.stringify(a.exportState(5_000_000, 'test'));
    const b = new Simulation({ rng: () => 0.5 });
    b.addGears(3);                       // gets replaced
    b.importState(parseSimState(text), 5_000_000);
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.gear(2)!.s.dt8).toBeDefined();
    expect(b.gear(1)!.s.dt0).toBeDefined();
  });

  it('keeps behaving like the original after the restore (answers, ids, new gears)', () => {
    const a = build();
    a.gear(0)!.forceLevel(77);
    const b = new Simulation();
    b.importState(parseSimState(JSON.stringify(a.exportState(0))), 0);
    expect(send(b, '01 A0', 1000, 1000)).toEqual(send(a, '01 A0', 1000, 1000));   // QUERY ACTUAL LEVEL
    expect(send(b, '01 A0', 1000, 1000)).toEqual({ kind: 'answer', byte: 77 });
    expect(b.addGear({}).id).toBe(4);                                                // ids continue
  });

  it('rebases a running fade onto the new clock', () => {
    const a = new Simulation();
    const g = a.addGear({ shortAddress: 0 });
    g.s.actualLevel = 0; g.s.fadeTime = 4;                       // ~2.8 s
    send(a, '00 FE', 0, 10_000_000);                              // DAPC 254 on short 0 starts a fade at t = 10 s
    expect(a.gear(0)!.s.fade).not.toBeNull();
    const file = parseSimState(JSON.stringify(a.exportState(11_000_000)));
    const b = new Simulation();
    b.importState(file, 500_000);                                 // new clock reads 0.5 s now
    const f = b.gear(0)!.s.fade!;
    expect(f.startUs).toBe(10_000_000 - 11_000_000 + 500_000);    // one second into the fade
    b.advance(500_000 + 60_000_000);
    expect(b.gear(0)!.s.actualLevel).toBe(254);
  });

  it('leaves the current gears alone when the file does not fit', () => {
    const sim = build();
    const before = sim.snapshot();
    const file: SimStateFile = sim.exportState(0);
    const big = new Simulation({ maxGears: 2 });
    big.addGear({});
    expect(() => big.importState(file, 0)).toThrow(/at most 2/);
    expect(big.gears).toHaveLength(1);
    expect(sim.snapshot()).toEqual(before);
  });

  it.each([
    ['not json', 'nope', /invalid JSON/],
    ['wrong format', '{"format":"x"}', /Not a DALI Scout state file/],
    ['wrong version', '{"format":"dali-scout-sim","version":9}', /version/],
    ['no gears', '{"format":"dali-scout-sim","version":1,"simNowUs":0}', /gears/]
  ])('rejects %s', (_n, text, re) => {
    expect(() => parseSimState(text)).toThrow(re);
  });

  it('rejects damaged gear data with a path', () => {
    const sim = build();
    const file = JSON.parse(JSON.stringify(sim.exportState(0)));
    file.gears[0].state.actualLevel = 'bright';
    expect(() => parseSimState(JSON.stringify(file))).toThrow(/gear 0\.actualLevel/);
    const f2 = JSON.parse(JSON.stringify(sim.exportState(0)));
    f2.gears[0].state.shortAddress = 64;
    expect(() => parseSimState(JSON.stringify(f2))).toThrow(/shortAddress/);
    const f3 = JSON.parse(JSON.stringify(sim.exportState(0)));
    delete f3.gears[2].state.dt8.actual;
    expect(() => parseSimState(JSON.stringify(f3))).toThrow(/missing "actual"/);
    const f4 = JSON.parse(JSON.stringify(sim.exportState(0)));
    f4.gears[1].id = f4.gears[0].id;
    expect(() => parseSimState(JSON.stringify(f4))).toThrow(/duplicate/);
  });
});
