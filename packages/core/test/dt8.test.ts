import { describe, expect, it } from 'vitest';
import {
  Gear, Simulation, colourLabel, gearBrightness, gearColour, channelToLevel, seqSetRgb, seqSetTc, seqSetXy, kelvinToXy, mirekToXy, mixPrimaries, renderColour, xyInGamut, xyToRgb, mirekToKelvin,
  type GearConfig
} from '../src/index.js';

/** One gear with its own bus clock; helpers for DT-extended commands. */
function bench(cfg: GearConfig) {
  const g = new Gear(0, { shortAddress: 5, ...cfg });
  let bus = 0, sim = 0;
  const tx = (a: number, d: number, gap = 20) => {
    bus += gap * 1000;
    return g.process(Uint8Array.of(a, d), 16, { busUs: bus, simUs: sim });
  };
  const api = {
    g, s: g.s, tx,
    advance(ms: number) { sim += ms * 1000; g.advance(sim); },
    dtr(v0: number, v1 = 0, v2 = 0) { tx(0xa3, v0); tx(0xc3, v1); tx(0xc5, v2); },
    word(v: number, dtr2 = 0) { api.dtr(v & 255, v >> 8, dtr2); },
    /** ENABLE DEVICE TYPE + extended command (once). */
    ext(dt: number, op: number) { tx(0xc1, dt); return tx(0x0b, op); },
    /** Same, twice, with ENABLE DEVICE TYPE before each copy as a real controller does. */
    extTwice(dt: number, op: number) { api.ext(dt, op); return api.ext(dt, op); }
  };
  return api;
}
const dt8 = (colour: GearConfig['colour'] = 'rgb-ct', more: GearConfig = {}) => bench({ colour, ...more });
const queryValue = (b: ReturnType<typeof bench>, sel: number): number | undefined => {
  b.tx(0xa3, sel);
  const hi = b.ext(8, 0xfa);
  return hi === undefined ? undefined : (hi << 8) | b.s.dtr0;
};

describe('colour maths', () => {
  it('xy -> sRGB for the primaries and the white point', () => {
    expect(xyToRgb(0.64, 0.33)).toEqual([255, 0, 0]);
    expect(xyToRgb(0.15, 0.06)[2]).toBe(255);
    const w = xyToRgb(0.3127, 0.329);
    for (const c of w) expect(c).toBeGreaterThan(245);
  });
  it('black-body locus: known points', () => {
    const d65 = kelvinToXy(6500);
    expect(d65.x).toBeCloseTo(0.3135, 2); expect(d65.y).toBeCloseTo(0.3237, 2);
    const a = kelvinToXy(2856);
    expect(a.x).toBeCloseTo(0.4476, 2); expect(a.y).toBeCloseTo(0.4074, 2);
    expect(mirekToKelvin(250)).toBe(4000);
    expect(mirekToXy(250).x).toBeCloseTo(0.38, 2);
  });
  it('warm light is reddish, cool light bluish', () => {
    const [r1, , b1] = xyToRgb(mirekToXy(370).x, mirekToXy(370).y);
    const [r2, , b2] = xyToRgb(mirekToXy(153).x, mirekToXy(153).y);
    expect(r1).toBeGreaterThan(b1); expect(b2).toBeGreaterThan(r2 - 60);
  });
  it('gamut test', () => {
    expect(xyInGamut(0.3127, 0.329)).toBe(true);
    expect(xyInGamut(0.1, 0.8)).toBe(false);
    expect(xyInGamut(0.3, 0)).toBe(false);
  });
  it('mixing primaries', () => {
    const P = [{ x: 0.64, y: 0.33 }, { x: 0.3, y: 0.6 }, { x: 0.15, y: 0.06 }];
    expect(mixPrimaries(P, [1, 0, 0])).toEqual([255, 0, 0]);
    expect(mixPrimaries(P, [0, 0, 0])).toEqual([0, 0, 0]);
    const yellow = mixPrimaries(P, [1, 1, 0]);
    expect(yellow[0]).toBeGreaterThan(200); expect(yellow[1]).toBeGreaterThan(200); expect(yellow[2]).toBe(0);
  });
});

describe('DT8 capabilities', () => {
  it('QUERY COLOUR TYPE FEATURES per preset', () => {
    const f = (c: GearConfig['colour']) => dt8(c).ext(8, 0xf9);
    expect(f('rgb')).toBe(0b011_011_01);      // 3 RGBWAF, 3 primaries, xy
    expect(f('rgbw')).toBe(0b100_100_01);
    expect(f('rgb-ct')).toBe(0b011_101_11);
    expect(f('tc')).toBe(0b000_010_10);
    expect(f('xy')).toBe(0b000_011_01);
  });
  it('gear with a colour config reports device type 8; a plain gear does not answer extended queries', () => {
    expect(dt8().tx(0x0b, 0x99)).toBe(8);
    const plain = bench({});
    expect(plain.ext(8, 0xf9)).toBeUndefined();
  });
  it('extended commands need ENABLE DEVICE TYPE first and the right type', () => {
    const b = dt8();
    expect(b.tx(0x0b, 0xf9)).toBeUndefined();
    expect(b.ext(0, 0xf9)).toBeUndefined();
    expect(b.ext(8, 0xf9)).toBe(0b011_101_11);
    expect(b.tx(0x0b, 0xf9)).toBeUndefined();         // enable was used up
  });
  it('extended version number is 1', () => {
    expect(dt8().ext(8, 0xff)).toBe(1);
  });
});

describe('DT8 colour control', () => {
  it('temporary registers only take effect on ACTIVATE', () => {
    const b = dt8('rgb-ct');
    const before = renderColour(b.s.dt8!).join();
    b.word(0xa000); b.ext(8, 0xe0);       // X
    b.word(0x4000); b.ext(8, 0xe1);       // Y
    expect(b.s.dt8!.actual.x).not.toBe(0xa000);
    expect(b.s.dt8!.tempMode).toBe('xy');
    b.ext(8, 0xe2);
    expect(b.s.dt8!.actual.x).toBe(0xa000); expect(b.s.dt8!.actual.y).toBe(0x4000);
    expect(b.s.dt8!.mode).toBe('xy');
    expect(b.s.dt8!.tempMode).toBeNull();
    expect(renderColour(b.s.dt8!).join()).not.toBe(before);
  });
  it('MASK in a temporary register leaves the value unchanged', () => {
    const b = dt8('rgb-ct');
    b.word(0x6000); b.ext(8, 0xe0); b.ext(8, 0xe2);
    const y = b.s.dt8!.actual.y;
    b.word(0x7000); b.ext(8, 0xe0); b.ext(8, 0xe2);   // only X written
    expect(b.s.dt8!.actual.x).toBe(0x7000); expect(b.s.dt8!.actual.y).toBe(y);
  });
  it('Tc: set, clamp to limits, status and report', () => {
    const b = dt8('rgb-ct');
    b.word(300); b.ext(8, 0xe7); b.ext(8, 0xe2);
    expect(b.s.dt8!.mode).toBe('tc'); expect(b.s.dt8!.actual.tc).toBe(300);
    expect(b.ext(8, 0xf8)! & 0xf0).toBe(0x20);                     // Tc active
    b.word(100); b.ext(8, 0xe7); b.ext(8, 0xe2);                  // cooler than the physical limit
    expect(b.s.dt8!.actual.tc).toBe(153);
    b.word(500); b.ext(8, 0xe7); b.ext(8, 0xe2);
    expect(b.s.dt8!.actual.tc).toBe(370);
    expect(queryValue(b, 2)).toBe(370);
  });
  it('Tc limits can be narrowed within the physical range', () => {
    const b = dt8('rgb-ct');
    b.word(200, 0); b.extTwice(8, 0xf2);       // coolest = 200 mirek
    b.word(300, 1); b.extTwice(8, 0xf2);       // warmest = 300
    expect([b.s.dt8!.coolestMirek, b.s.dt8!.warmestMirek]).toEqual([200, 300]);
    b.word(153); b.ext(8, 0xe7); b.ext(8, 0xe2);
    expect(b.s.dt8!.actual.tc).toBe(200);
    b.word(100, 0); b.extTwice(8, 0xf2);       // below physical: clamped
    expect(b.s.dt8!.coolestMirek).toBe(153);
  });
  it('Tc step cooler / warmer moves by one mirek within limits', () => {
    const b = dt8('rgb-ct');
    b.word(250); b.ext(8, 0xe7); b.ext(8, 0xe2);
    b.ext(8, 0xe8); expect(b.s.dt8!.actual.tc).toBe(249);
    b.ext(8, 0xe9); b.ext(8, 0xe9); expect(b.s.dt8!.actual.tc).toBe(251);
  });
  it('primaries: single, all, out-of-range index ignored', () => {
    const b = dt8('rgb');
    b.word(0x8000, 1); b.ext(8, 0xea); b.ext(8, 0xe2);
    expect(b.s.dt8!.actual.primary.slice(0, 3)).toEqual([0xfffe, 0x8000, 0xfffe]);
    b.word(0x1000, 255); b.ext(8, 0xea); b.ext(8, 0xe2);
    expect(b.s.dt8!.actual.primary.slice(0, 3)).toEqual([0x1000, 0x1000, 0x1000]);
    b.word(0x0001, 5); b.ext(8, 0xea); b.ext(8, 0xe2);                    // primary 5 does not exist on an RGB gear
    expect(b.s.dt8!.actual.primary[5]).toBe(0);
    expect(b.s.dt8!.mode).toBe('primary');
    expect(queryValue(b, 4)).toBe(0x1000);                                  // 3 + index 1
  });
  it('RGB and WAF levels', () => {
    const b = dt8('rgbw');
    b.dtr(254, 0, 0); b.ext(8, 0xeb); b.ext(8, 0xe2);
    expect(b.s.dt8!.mode).toBe('rgbwaf');
    expect(b.s.dt8!.actual.rgbwaf.slice(0, 3)).toEqual([254, 0, 0]);
    expect(renderColour(b.s.dt8!)[0]).toBeGreaterThan(200);
    b.dtr(100, 7, 9); b.ext(8, 0xec); b.ext(8, 0xe2);                     // W, A, F: only W exists on RGBW
    expect(b.s.dt8!.actual.rgbwaf[3]).toBe(100);
    expect(b.s.dt8!.actual.rgbwaf[4]).toBe(0);
    expect(queryValue(b, 64 + 3)).toBe(100);
  });
  it('RGBWAF control byte round trip', () => {
    const b = dt8('rgbw');
    b.dtr(0b101); b.ext(8, 0xed); b.ext(8, 0xe2);
    expect(b.ext(8, 0xfb)).toBe(0b101);
  });
  it('unsupported colour types are ignored', () => {
    const b = dt8('rgb');                         // no Tc
    b.word(300); b.ext(8, 0xe7);
    expect(b.s.dt8!.tempMode).toBeNull();
    const t = dt8('tc');                          // no xy
    t.word(0x8000); t.ext(8, 0xe0);
    expect(t.s.dt8!.tempMode).toBeNull();
  });
  it('xy step up/down and COPY REPORT TO TEMPORARY', () => {
    const b = dt8('xy');
    const x0 = b.s.dt8!.actual.x;
    b.ext(8, 0xe3); b.ext(8, 0xe3); b.ext(8, 0xe4);
    expect(b.s.dt8!.actual.x).toBe(x0 + 1);
    b.ext(8, 0xe5); expect(b.s.dt8!.actual.y).toBe(b.s.dt8!.report.y);
    b.ext(8, 0xee);
    expect(b.s.dt8!.temp.x).toBe(x0 + 1);
  });
  it('out-of-gamut xy is flagged in the colour status', () => {
    const b = dt8('xy');
    b.word(Math.round(0.1 * 65536)); b.ext(8, 0xe0);
    b.word(Math.round(0.8 * 65536)); b.ext(8, 0xe1);
    b.ext(8, 0xe2);
    expect(b.ext(8, 0xf8)! & 1).toBe(1);
  });
});

describe('DT8 fading', () => {
  it('colour fades with the gear fade time', () => {
    const b = dt8('rgb-ct');
    b.tx(0xa3, 4); b.tx(0x0b, 0x2e); b.tx(0x0b, 0x2e);       // fade time 2.0 s
    b.word(0x6000); b.ext(8, 0xe0); b.ext(8, 0xe2);
    const from = b.s.dt8!.actual.x;
    expect(b.s.dt8!.fade).not.toBeNull();
    b.advance(1000);
    const mid = b.s.dt8!.actual.x;
    expect(mid).toBeGreaterThan(Math.min(from, 0x6000)); expect(mid).toBeLessThan(Math.max(from, 0x6000));
    expect(b.s.dt8!.report.x).toBe(0x6000);
    b.advance(1100);
    expect(b.s.dt8!.actual.x).toBe(0x6000);
    expect(b.s.dt8!.fade).toBeNull();
  });
  it('a query during the fade sees the actual value, report holds the target', () => {
    const b = dt8('rgb-ct');
    b.tx(0xa3, 4); b.tx(0x0b, 0x2e); b.tx(0x0b, 0x2e);
    b.word(0x1000); b.ext(8, 0xe0); b.ext(8, 0xe2);
    b.advance(500);
    expect(queryValue(b, 0)).toBe(b.s.dt8!.actual.x);
    expect(queryValue(b, 192)).toBe(0x1000);
  });
});

describe('DT8 scenes, reset, storage', () => {
  it('SET SCENE captures the temporary colour, GO TO SCENE recalls it', () => {
    const b = dt8('rgb-ct');
    b.tx(0xa3, 120);
    b.word(280); b.ext(8, 0xe7);               // temp Tc 280
    b.tx(0xa3, 120); b.tx(0x0b, 0x42); b.tx(0x0b, 0x42);   // SET SCENE 2 = level 120
    b.word(153); b.ext(8, 0xe7); b.ext(8, 0xe2);
    expect(b.s.dt8!.actual.tc).toBe(153);
    b.tx(0x0b, 0x12);                          // GO TO SCENE 2
    expect(b.s.actualLevel).toBe(120);
    expect(b.s.dt8!.actual.tc).toBe(280); expect(b.s.dt8!.mode).toBe('tc');
    b.tx(0x0b, 0x52); b.tx(0x0b, 0x52);        // REMOVE FROM SCENE 2
    expect(b.s.dt8!.sceneColours[2]).toBeNull();
  });
  it('RESET returns to the default colour but keeps stored primaries and limits', () => {
    const b = dt8('rgb-ct');
    b.word(0x9000); b.ext(8, 0xe0); b.ext(8, 0xe2);
    b.word(0x3000); b.ext(8, 0xe0); b.word(0x3500); b.ext(8, 0xe1);
    b.dtr(0, 0, 1); b.extTwice(8, 0xf1);                       // STORE XY PRIMARY 1 from temp
    expect(b.s.dt8!.primaryXy[1]!.x).toBeCloseTo(0x3000 / 65536, 5);
    b.tx(0x0b, 0x20); b.tx(0x0b, 0x20);                         // RESET
    expect(b.s.dt8!.actual.x).toBe(Math.round(0.3127 * 65536));
    expect(b.s.dt8!.primaryXy[1]!.x).toBeCloseTo(0x3000 / 65536, 5);
  });
  it('configuration commands need two copies', () => {
    const b = dt8('rgb-ct');
    b.dtr(2, 0, 1);                      // channel 1 -> assignment 2... DTR2 = channel
    b.ext(8, 0xf4);                      // only once
    expect(b.s.dt8!.assigned[1]).toBe(0);
    b.ext(8, 0xf4);
    expect(b.s.dt8!.assigned[1]).toBe(2);
    b.tx(0xa3, 1);
    expect(b.ext(8, 0xfc)).toBe(2);
  });
  it('QUERY COLOUR VALUE selector for unknown ids is silent', () => {
    const b = dt8('rgb-ct');
    expect(queryValue(b, 99)).toBeUndefined();
  });
  it('a gear with two device types answers both extension sets', () => {
    const b = bench({ deviceTypes: [0, 8], colour: 'tc' });
    expect(b.ext(8, 0xf9)).toBe(0b000_010_10);
    expect(b.ext(0, 0xee)).toBe(0);
    expect(b.tx(0x0b, 0x99)).toBe(254);
  });
});

describe('DT0', () => {
  const dt0 = () => bench({ deviceTypes: [0] });
  it('reports its identity and defaults', () => {
    const b = dt0();
    expect(b.tx(0x0b, 0x99)).toBe(0);
    expect(b.ext(0, 0xed)).toBe(0);          // gear type
    expect(b.ext(0, 0xee)).toBe(0);          // standard dimming curve
    expect(b.ext(0, 0xf3)).toBe(1);
    expect(b.ext(0, 0xf2)).toBe(1);
    expect(b.ext(0, 0xf1)).toBe(0);
  });
  it('select dimming curve (twice) and fast fade time', () => {
    const b = dt0();
    b.tx(0xa3, 1); b.extTwice(0, 0xe3);
    expect(b.ext(0, 0xee)).toBe(1);
    b.tx(0xa3, 5); b.extTwice(0, 0xe3);       // invalid: unchanged
    expect(b.ext(0, 0xee)).toBe(1);
    b.tx(0xa3, 12); b.extTwice(0, 0xe4);
    expect(b.ext(0, 0xf1)).toBe(12);
    b.tx(0xa3, 200); b.extTwice(0, 0xe4);
    expect(b.ext(0, 0xf1)).toBe(27);          // limited to 27 x 25 ms
  });
  it('a single copy of a configuration command does nothing', () => {
    const b = dt0();
    b.tx(0xa3, 1); b.ext(0, 0xe3);
    expect(b.ext(0, 0xee)).toBe(0);
  });
  it('current protector', () => {
    const b = dt0();
    expect(b.ext(0, 0xf4)).toBe(255);
    b.extTwice(0, 0xe2);
    expect(b.ext(0, 0xf4)).toBeUndefined();
    b.extTwice(0, 0xe1);
    expect(b.ext(0, 0xf4)).toBe(255);
  });
  it('reference system power runs 15 s on the simulation clock', () => {
    const b = dt0();
    b.extTwice(0, 0xe0);
    expect(b.s.dt0!.referenceUntilUs).toBeGreaterThan(0);
    b.advance(14_000); expect(b.s.dt0!.referencePowerDone).toBe(false);
    b.advance(2_000); expect(b.s.dt0!.referencePowerDone).toBe(true);
    expect(b.s.dt0!.referenceUntilUs).toBe(0);
  });
  it('operating mode query follows SET OPERATING MODE; RESET restores DT0 defaults', () => {
    const b = dt0();
    b.tx(0xa3, 1); b.tx(0x0b, 0x23); b.tx(0x0b, 0x23);
    expect(b.ext(0, 0xf0)).toBe(1);
    b.tx(0xa3, 1); b.extTwice(0, 0xe3);
    b.tx(0x0b, 0x20); b.tx(0x0b, 0x20);
    expect(b.ext(0, 0xee)).toBe(0);
    expect(b.s.operatingMode).toBe(0);
  });
  it('lamp failure still shows in the standard status for DT0', () => {
    const b = dt0();
    b.g.setFault({ lampFailure: true });
    expect(b.tx(0x0b, 0x92)).toBe(255);
  });
});

describe('send-twice with ENABLE DEVICE TYPE in between', () => {
  it('the ENABLE frame does not break the pair, other frames do', () => {
    const b = dt8('rgb-ct');
    b.dtr(5, 0, 2);
    b.ext(8, 0xf4); b.tx(0x0b, 0x91); b.ext(8, 0xf4);       // QUERY CONTROL GEAR in between: cancels
    expect(b.s.dt8!.assigned[2]).toBe(0);
    b.ext(8, 0xf4);
    expect(b.s.dt8!.assigned[2]).toBe(5);
  });
});

describe('Simulation with colour gear', () => {
  it('snapshots carry the colour state and stay independent', () => {
    const sim = new Simulation();
    sim.addGear({ colour: 'rgbw', shortAddress: 0 });
    sim.addGear({ deviceTypes: [0], shortAddress: 1 });
    const snap = sim.snapshot();
    expect(snap[0]!.state.dt8!.cfg.primaries).toBe(4);
    expect(snap[0]!.state.deviceTypes).toEqual([8]);
    expect(snap[1]!.state.dt0).toBeDefined();
    snap[0]!.state.dt8!.actual.x = 1;
    expect(sim.gears[0]!.s.dt8!.actual.x).not.toBe(1);
  });
  it('65 mixed gear stay responsive: broadcast colour change reaches all colour gear', () => {
    const sim = new Simulation();
    for (let i = 0; i < 65; i++) {
      sim.addGear(i % 3 === 0 ? { colour: 'rgb-ct', shortAddress: i < 64 ? i : null }
        : i % 3 === 1 ? { deviceTypes: [0], shortAddress: i < 64 ? i : null } : { shortAddress: i < 64 ? i : null });
    }
    let t = 0;
    const tx = (a: number, d: number) => sim.process(Uint8Array.of(a, d), 16, { busUs: (t += 20_000), simUs: t });
    tx(0xa3, 0x00); tx(0xc3, 0x70);                 // DTR1:DTR0 = 0x7000 (Tc invalid for xy but fine for X)
    tx(0xc1, 8); tx(0xff, 0xe0); tx(0xc1, 8); tx(0xff, 0xe2);
    const colour = sim.gears.filter((g) => g.s.dt8);
    expect(colour).toHaveLength(22);
    expect(colour.every((g) => g.s.dt8!.actual.x === 0x7000)).toBe(true);
    expect(sim.gears.filter((g) => !g.s.dt8).every((g) => g.s.dtr1 === 0x70)).toBe(true);
  });
});

describe('colour command sequences', () => {
  const play = (b: ReturnType<typeof bench>, seq: { data: Uint8Array }[]) => seq.forEach((f) => b.tx(f.data[0]!, f.data[1]!));
  it('seqSetRgb drives an RGB gear to the colour', () => {
    const b = dt8('rgb');
    play(b, seqSetRgb({ kind: 'short', value: 5 }, channelToLevel(255), 0, 0));
    expect(b.s.dt8!.mode).toBe('rgbwaf');
    expect(renderColour(b.s.dt8!)[0]).toBe(255);
    expect(renderColour(b.s.dt8!)[1]).toBe(0);
  });
  it('seqSetTc and seqSetXy', () => {
    const b = dt8('rgb-ct');
    play(b, seqSetTc({ kind: 'broadcast' }, 300));
    expect(b.s.dt8!.actual.tc).toBe(300);
    play(b, seqSetXy({ kind: 'broadcast' }, 0.5, 0.25));
    expect([b.s.dt8!.actual.x, b.s.dt8!.actual.y]).toEqual([32768, 16384]);
  });
  it('twice-sent steps are not needed for the temporary registers, and DT is re-enabled before each frame', () => {
    const seq = seqSetRgb({ kind: 'broadcast' }, 1, 2, 3);
    expect(seq.map((f) => f.data[0]!.toString(16))).toEqual(['a3', 'c3', 'c5', 'c1', 'ff', 'c1', 'ff']);
  });
});

describe('visual helpers', () => {
  it('brightness follows the dimming curve and faults', () => {
    const lin = bench({ deviceTypes: [0] });
    lin.g.forceLevel(127);
    const log = gearBrightness(lin.s);
    lin.tx(0xa3, 1); lin.extTwice(0, 0xe3);
    expect(gearBrightness(lin.s)).toBeCloseTo(0.5, 2);
    expect(log).toBeLessThan(0.05);
    lin.g.setFault({ lampFailure: true });
    expect(gearBrightness(lin.s)).toBe(0);
  });
  it('colour label and light colour', () => {
    expect(colourLabel(dt8('rgb-ct').s)).toBe('RGB+CT');
    expect(colourLabel(dt8('rgbw').s)).toBe('RGBW');
    expect(colourLabel(dt8('tc').s)).toBe('CT');
    expect(colourLabel(dt8('rgb').s)).toBe('RGB');
    expect(colourLabel(bench({}).s)).toBeNull();
    const [r, , b] = gearColour(dt8('rgb').s);
    expect(r).toBeGreaterThan(240); expect(b).toBeGreaterThan(240);   // default white
  });
});
