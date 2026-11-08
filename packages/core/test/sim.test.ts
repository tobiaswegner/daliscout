import { describe, expect, it } from 'vitest';
import {
  Gear, Simulation, commissionBus, fadeDurationUs, fadeRateStepsPerSecond, fadeTimeSeconds,
  type CommissioningIo, type GearConfig, type SimReply
} from '../src/index.js';

/** Deterministic PRNG (mulberry32) so random addresses are reproducible. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A one-gear bench with a bus clock that advances 20 ms per frame. */
function bench(cfg: GearConfig = { shortAddress: 5 }) {
  const g = new Gear(0, cfg, seeded(1));
  let bus = 0, sim = 0;
  const api = {
    g, s: g.s,
    /** Send a frame, return the answer byte. */
    tx(a: number, d: number, gapMs = 20): number | undefined {
      bus += gapMs * 1000;
      return g.process(Uint8Array.of(a, d), 16, { busUs: bus, simUs: sim });
    },
    /** Configuration command: send twice. */
    cfg(a: number, d: number) { api.tx(a, d); return api.tx(a, d); },
    advance(ms: number) { sim += ms * 1000; g.advance(sim); },
    dtr0(v: number) { api.tx(0xa3, v); },
    get now() { return sim; }
  };
  return api;
}
const S5 = 0x0b; // short address 5, S=1
const D5 = 0x0a; // short address 5, S=0 (DAPC)
const BC = 0xff, BCD = 0xfe;

describe('fade tables', () => {
  it('match IEC 62386-102', () => {
    expect(fadeTimeSeconds(0)).toBe(0);
    expect(fadeTimeSeconds(1)).toBeCloseTo(0.707, 3);
    expect(fadeTimeSeconds(2)).toBeCloseTo(1.0, 3);
    expect(fadeTimeSeconds(15)).toBeCloseTo(90.5, 1);
    expect(fadeRateStepsPerSecond(1)).toBeCloseTo(357.8, 1);
    expect(fadeRateStepsPerSecond(7)).toBeCloseTo(44.7, 1);
    expect(fadeRateStepsPerSecond(15)).toBeCloseTo(2.8, 1);
  });
  it('extended fade time overrides the basic fade time', () => {
    expect(fadeDurationUs(4, 0)).toBe(2_000_000);
    expect(fadeDurationUs(4, 0x33)).toBe(40_000_000);  // 4 x 10 s
    expect(fadeDurationUs(0, 0x22)).toBe(3_000_000);   // 3 x 1 s
    expect(fadeDurationUs(0, 0x12)).toBe(300_000);     // 3 x 100 ms
    expect(fadeDurationUs(0, 0x4f)).toBe(16 * 60_000_000);
    expect(fadeDurationUs(0, 0x0f)).toBe(0);           // multiplier 0 = no extended fade
  });
});

describe('addressing', () => {
  it('matches short, group, broadcast and broadcast unaddressed', () => {
    const b = bench({ shortAddress: 5 });
    b.cfg(S5, 0x62);                                          // ADD TO GROUP 2 (short 5)
    expect(b.s.groups).toBe(1 << 2);
    b.tx(D5, 100); expect(b.s.actualLevel).toBe(100);
    b.tx(0x0c, 50); expect(b.s.actualLevel).toBe(100);               // short 6: not us
    b.tx(0x84, 60); expect(b.s.actualLevel).toBe(60);                // group 2 DAPC
    b.tx(0x82, 70); expect(b.s.actualLevel).toBe(60);                // group 1: not us
    b.tx(BCD, 80); expect(b.s.actualLevel).toBe(80);                 // broadcast
    b.tx(0xfc, 90); expect(b.s.actualLevel).toBe(80);                // unaddressed broadcast: we have an address
  });
  it('an unaddressed gear answers broadcast unaddressed only', () => {
    const b = bench({ shortAddress: null });
    b.tx(0xfc, 90); expect(b.s.actualLevel).toBe(90);
    b.tx(D5, 10); expect(b.s.actualLevel).toBe(90);
  });
  it('ignores non-16-bit frames', () => {
    const b = bench();
    expect(b.g.process(Uint8Array.of(1, 2, 3), 24, { busUs: 0, simUs: 0 })).toBeUndefined();
    expect(b.s.actualLevel).toBe(254);
  });
});

describe('arc power control', () => {
  it('DAPC is immediate without fade time, 0 switches off', () => {
    const b = bench();
    b.tx(D5, 100); expect(b.s.actualLevel).toBe(100);
    expect(b.s.lastActiveLevel).toBe(100);
    b.tx(D5, 0); expect(b.s.actualLevel).toBe(0);
    expect(b.s.lastActiveLevel).toBe(100);
  });
  it('clamps to min/max and flags a limit error', () => {
    const b = bench({ shortAddress: 5, physicalMin: 10 });
    b.dtr0(50); b.cfg(S5, 0x2a);  // max 50
    b.dtr0(20); b.cfg(S5, 0x2b);  // min 20
    expect([b.s.minLevel, b.s.maxLevel]).toEqual([20, 50]);
    b.tx(D5, 200); expect(b.s.actualLevel).toBe(50); expect(b.s.limitError).toBe(true);
    b.tx(D5, 5); expect(b.s.actualLevel).toBe(20);
    b.tx(D5, 30); expect(b.s.actualLevel).toBe(30); expect(b.s.limitError).toBe(false);
  });
  it('min/max respect physical minimum and each other', () => {
    const b = bench({ shortAddress: 5, physicalMin: 10 });
    b.dtr0(3); b.cfg(S5, 0x2b); expect(b.s.minLevel).toBe(10);
    b.dtr0(5); b.cfg(S5, 0x2a); expect(b.s.maxLevel).toBe(10); // cannot go below min
  });
  it('lowering max pulls the actual level down', () => {
    const b = bench();
    b.dtr0(100); b.cfg(S5, 0x2a);
    expect(b.s.actualLevel).toBe(100);
  });
  it('fades with the fade time, linear in level steps', () => {
    const b = bench();
    b.tx(D5, 0);
    b.dtr0(4); b.cfg(S5, 0x2e);                 // fade time 4 = 2.0 s
    b.tx(D5, 200);
    expect(b.s.fade).not.toBeNull();
    expect(b.s.actualLevel).toBe(0);            // fading up from off starts at min below
    b.advance(1000);
    expect(b.s.actualLevel).toBeGreaterThan(95); expect(b.s.actualLevel).toBeLessThan(105);
    expect(b.g.statusByte() & 16).toBe(16);     // fade running
    b.advance(1100);
    expect(b.s.actualLevel).toBe(200);
    expect(b.s.fade).toBeNull();
    expect(b.g.statusByte() & 16).toBe(0);
  });
  it('fading down to off ends at 0', () => {
    const b = bench();
    b.dtr0(2); b.cfg(S5, 0x2e);                  // 1.0 s
    b.tx(D5, 0);
    b.advance(500); expect(b.s.actualLevel).toBeGreaterThan(0);
    b.advance(600); expect(b.s.actualLevel).toBe(0);
  });
  it('DAPC MASK stops a running fade', () => {
    const b = bench();
    b.tx(D5, 10);
    b.dtr0(8); b.cfg(S5, 0x2e);
    b.tx(D5, 250);
    b.advance(2000);
    const mid = b.s.actualLevel;
    expect(mid).toBeGreaterThan(10);
    b.tx(D5, 255);
    b.advance(20000);
    expect(b.s.actualLevel).toBe(mid);
    expect(b.s.fade).toBeNull();
  });
  it('OFF is immediate even with a fade time; RECALL MAX/MIN', () => {
    const b = bench({ shortAddress: 5, physicalMin: 5 });
    b.dtr0(8); b.cfg(S5, 0x2e);
    b.tx(S5, 0x00); expect(b.s.actualLevel).toBe(0);
    b.tx(S5, 0x05); expect(b.s.actualLevel).toBe(254);
    b.tx(S5, 0x06); expect(b.s.actualLevel).toBe(5);
  });
  it('STEP UP/DOWN do not switch on or off; ON AND STEP UP and STEP DOWN AND OFF do', () => {
    const b = bench({ shortAddress: 5, physicalMin: 10 });
    b.tx(D5, 0);
    b.tx(S5, 0x03); expect(b.s.actualLevel).toBe(0);      // STEP UP: not on
    b.tx(S5, 0x08); expect(b.s.actualLevel).toBe(10);     // ON AND STEP UP: on at min
    b.tx(S5, 0x08); expect(b.s.actualLevel).toBe(11);
    b.tx(S5, 0x04); expect(b.s.actualLevel).toBe(10);     // STEP DOWN
    b.tx(S5, 0x04); expect(b.s.actualLevel).toBe(10);     // not below min
    b.tx(S5, 0x07); expect(b.s.actualLevel).toBe(0);      // STEP DOWN AND OFF at min -> off
    b.tx(D5, 100);
    b.tx(S5, 0x07); expect(b.s.actualLevel).toBe(99);
    b.tx(D5, 254); b.tx(S5, 0x03); expect(b.s.actualLevel).toBe(254); // not above max
  });
  it('UP/DOWN fade for 200 ms at the fade rate and need the lamp on', () => {
    const b = bench();
    b.tx(D5, 100);
    b.dtr0(7); b.cfg(S5, 0x2f);                           // 44.7 steps/s -> ~9 steps in 200 ms
    b.tx(S5, 0x01); b.advance(250);
    expect(b.s.actualLevel).toBe(109);
    b.tx(S5, 0x02); b.advance(250);
    expect(b.s.actualLevel).toBe(100);
    b.tx(D5, 0);
    b.tx(S5, 0x01); b.advance(250);
    expect(b.s.actualLevel).toBe(0);                      // UP does not switch on
  });
  it('GO TO LAST ACTIVE LEVEL', () => {
    const b = bench();
    b.tx(D5, 77); b.tx(D5, 0);
    b.tx(S5, 0x0a); expect(b.s.actualLevel).toBe(77);
  });
});

describe('send twice', () => {
  it('a configuration command needs two identical frames within 100 ms', () => {
    const b = bench();
    b.dtr0(33);
    b.tx(S5, 0x2d);                       // only once
    expect(b.s.powerOnLevel).toBe(254);
    b.tx(S5, 0x2d);                       // twice
    expect(b.s.powerOnLevel).toBe(33);
  });
  it('too slow, or interrupted by another frame, does not count', () => {
    const b = bench();
    b.dtr0(33);
    b.tx(S5, 0x2d); b.tx(S5, 0x2d, 150);   // 150 ms apart: only arms again
    expect(b.s.powerOnLevel).toBe(254);
    b.tx(S5, 0x2d);                         // now it is the second of an in-time pair
    expect(b.s.powerOnLevel).toBe(33);

    b.dtr0(44);
    b.tx(S5, 0x2d); b.tx(D5, 10); b.tx(S5, 0x2d);   // another frame in between
    expect(b.s.powerOnLevel).toBe(33);
  });
  it('a different command does not complete the pair', () => {
    const b = bench();
    b.dtr0(60);
    b.tx(S5, 0x2d); b.tx(S5, 0x2c);
    expect(b.s.powerOnLevel).toBe(254); expect(b.s.systemFailureLevel).toBe(255);
  });
});

describe('configuration', () => {
  it('scenes: set, go to, query, remove', () => {
    const b = bench();
    b.dtr0(90); b.cfg(S5, 0x43);                 // SET SCENE 3 = 90
    expect(b.tx(S5, 0xb3)).toBe(90);             // QUERY SCENE LEVEL 3
    b.tx(D5, 10); b.tx(S5, 0x13); expect(b.s.actualLevel).toBe(90);
    b.tx(S5, 0x14); expect(b.s.actualLevel).toBe(90);      // scene 4 not set: ignored
    b.cfg(S5, 0x53); expect(b.tx(S5, 0xb3)).toBe(255);     // REMOVE FROM SCENE 3
  });
  it('a scene level of 0 switches off', () => {
    const b = bench();
    b.dtr0(0); b.cfg(S5, 0x40);
    b.tx(S5, 0x10); expect(b.s.actualLevel).toBe(0);
  });
  it('groups: add, remove, query', () => {
    const b = bench();
    b.cfg(S5, 0x60); b.cfg(S5, 0x6f); b.cfg(S5, 0x63);
    expect(b.tx(S5, 0xc0)).toBe(0b1001);
    expect(b.tx(S5, 0xc1)).toBe(0x80);
    b.cfg(S5, 0x70);
    expect(b.tx(S5, 0xc0)).toBe(0b1000);
  });
  it('short address via DTR0, including delete', () => {
    const b = bench();
    b.dtr0((12 << 1) | 1); b.cfg(S5, 0x80);
    expect(b.s.shortAddress).toBe(12);
    b.dtr0(0x22); b.cfg(0x19, 0x80);              // even/invalid pattern: ignored
    expect(b.s.shortAddress).toBe(12);
    b.dtr0(255); b.cfg(0x19, 0x80);
    expect(b.s.shortAddress).toBeNull();
    expect(b.tx(BC, 0x96)).toBe(255);             // QUERY MISSING SHORT ADDRESS
  });
  it('fade time, fade rate and extended fade time with limits', () => {
    const b = bench();
    b.dtr0(200); b.cfg(S5, 0x2e); expect(b.s.fadeTime).toBe(15);
    b.dtr0(0); b.cfg(S5, 0x2f); expect(b.s.fadeRate).toBe(1);
    b.dtr0(0x23); b.cfg(S5, 0x30); expect(b.s.extendedFadeTime).toBe(0x23);
    b.dtr0(0x73); b.cfg(S5, 0x30); expect(b.s.extendedFadeTime).toBe(0);     // multiplier 7 is invalid
    b.dtr0(0x35); b.cfg(S5, 0x2e); b.dtr0(0x09); b.cfg(S5, 0x2f);
    expect(b.tx(S5, 0xa5)).toBe(0xf9);
  });
  it('RESET restores defaults but keeps the short address', () => {
    const b = bench();
    b.dtr0(40); b.cfg(S5, 0x2d); b.cfg(S5, 0x61); b.cfg(S5, 0x41);
    expect(b.tx(S5, 0x95)).toBeUndefined();         // not in reset state
    b.cfg(S5, 0x20);
    expect([b.s.powerOnLevel, b.s.groups, b.s.scenes[1], b.s.shortAddress]).toEqual([254, 0, 255, 5]);
    expect(b.tx(S5, 0x95)).toBe(255);
    expect(b.s.randomAddress).toBe(0xffffff);
  });
  it('STORE ACTUAL LEVEL IN DTR0', () => {
    const b = bench();
    b.tx(D5, 123); b.cfg(S5, 0x21);
    expect(b.tx(S5, 0x98)).toBe(123);
  });
});

describe('queries', () => {
  it('status byte bits', () => {
    const b = bench({ shortAddress: 5 });
    b.cfg(S5, 0x20);                      // reset state, powerFailure cleared by RESET
    b.tx(D5, 100);
    expect(b.tx(S5, 0x90)).toBe(0b0010_0100);   // arc on + reset state
    b.dtr0(1); b.cfg(S5, 0x2d);                  // configure -> not in reset state any more
    expect(b.tx(S5, 0x90)).toBe(0b0000_0100);
    b.s.shortAddress = null; b.tx(0xfe, 0); b.s.powerFailure = true; // switch off first: arc commands clear the flag
    expect(b.tx(0xfd, 0x90)).toBe(0b1100_0000);  // unaddressed + power failure, lamp off
  });
  it('yes/no queries answer 255 or stay silent', () => {
    const b = bench();
    expect(b.tx(S5, 0x91)).toBe(255);            // present
    expect(b.tx(S5, 0x92)).toBeUndefined();      // lamp failure
    expect(b.tx(S5, 0x93)).toBe(255);            // lamp on
    expect(b.tx(S5, 0x9b)).toBe(255);            // power failure (fresh gear, no arc command yet)
    b.tx(D5, 0); expect(b.tx(S5, 0x93)).toBeUndefined();
    expect(b.tx(S5, 0x9b)).toBeUndefined();      // an arc power command clears it
  });
  it('level and limit queries', () => {
    const b = bench({ shortAddress: 5, physicalMin: 7 });
    b.tx(D5, 150);
    expect([0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0x9a].map((op) => b.tx(S5, op))).toEqual([150, 254, 7, 254, 255, 7]);
    expect(b.tx(S5, 0x97)).toBe(8);              // version
  });
  it('DTR contents', () => {
    const b = bench();
    b.tx(0xa3, 11); b.tx(0xc3, 22); b.tx(0xc5, 33);
    expect([0x98, 0x9c, 0x9d].map((op) => b.tx(S5, op))).toEqual([11, 22, 33]);
  });
  it('device types', () => {
    expect(bench({ shortAddress: 5 }).tx(S5, 0x99)).toBe(255);
    expect(bench({ shortAddress: 5, deviceTypes: [8] }).tx(S5, 0x99)).toBe(8);
    const m = bench({ shortAddress: 5, deviceTypes: [6, 8] });
    expect(m.tx(S5, 0x99)).toBe(254);
    expect([m.tx(S5, 0xa7), m.tx(S5, 0xa7), m.tx(S5, 0xa7)]).toEqual([6, 8, 255]);
  });
  it('memory bank 0 is readable with auto-increment and read-only', () => {
    const b = bench();
    b.tx(0xc3, 0); b.tx(0xa3, 0);                  // bank 0, location 0
    expect(b.tx(S5, 0xc5)).toBe(0x1a);             // last accessible location
    expect(b.s.dtr0).toBe(1);
    expect(b.tx(S5, 0xc5)).toBe(0x00);
    b.tx(0xa3, 0x1b); expect(b.tx(S5, 0xc5)).toBeUndefined();   // beyond the end
    b.tx(0xc3, 9); b.tx(0xa3, 0); expect(b.tx(S5, 0xc5)).toBeUndefined(); // no such bank
    // write attempt on bank 0 is refused
    b.tx(0xc3, 0); b.tx(0xa3, 5); b.cfg(S5, 0x81);
    expect(b.tx(0xc7, 0x99)).toBeUndefined();
  });
  it('writable memory needs ENABLE WRITE MEMORY and is cleared by other commands', () => {
    const b = bench();
    b.tx(0xc3, 1); b.tx(0xa3, 2);
    expect(b.tx(0xc7, 0x42)).toBeUndefined();     // not enabled
    b.cfg(S5, 0x81);
    expect(b.tx(0xc7, 0x42)).toBe(0x42);           // written, echoed
    expect(b.s.memory[1]![2]).toBe(0x42);
    expect(b.s.dtr0).toBe(3);
    expect(b.tx(0xc9, 0x43)).toBeUndefined();      // no reply variant, location 3 is the last one
    expect(b.s.memory[1]![3]).toBe(0x43);
    b.tx(D5, 10);                                   // any other command ends write access
    b.tx(0xa3, 2);
    expect(b.tx(0xc7, 0x55)).toBeUndefined();
    expect(b.s.memory[1]![2]).toBe(0x42);
  });
});

describe('device type extension point', () => {
  it('ENABLE DEVICE TYPE applies to the next frame only', () => {
    const calls: [number, number][] = [];
    class Probe extends Gear {
      protected override extended(dt: number, op: number) { calls.push([dt, op]); return 0x77; }
    }
    const g = new Probe(0, { shortAddress: 5 });
    let t = 0;
    const tx = (a: number, d: number) => g.process(Uint8Array.of(a, d), 16, { busUs: (t += 20_000), simUs: t });
    tx(0xc1, 8);
    expect(tx(S5, 0xe2)).toBe(0x77);
    expect(tx(S5, 0xe2)).toBeUndefined();     // enable is used up
    tx(0xc1, 8); tx(D5, 10); expect(tx(S5, 0xe2)).toBeUndefined();  // any frame in between cancels it
    expect(calls).toEqual([[8, 0xe2]]);
  });
});

describe('faults and power', () => {
  it('lamp failure: status, queries, no light', () => {
    const b = bench();
    b.tx(D5, 100);
    b.g.setFault({ lampFailure: true });
    expect(b.tx(S5, 0x92)).toBe(255);
    expect(b.tx(S5, 0x93)).toBeUndefined();
    expect(b.tx(S5, 0x90)! & 0b110).toBe(0b010);
    expect(b.g.lampOn).toBe(false);
  });
  it('offline gear ignores everything, noAnswer gear still obeys', () => {
    const off = bench(); off.g.setFault({ offline: true });
    off.tx(D5, 10); expect(off.s.actualLevel).toBe(254);
    expect(off.tx(S5, 0x91)).toBeUndefined();
    const mute = bench(); mute.g.setFault({ noAnswer: true });
    mute.tx(D5, 10); expect(mute.s.actualLevel).toBe(10);
    expect(mute.tx(S5, 0x91)).toBeUndefined();
  });
  it('power cycle applies the power-on level and drops volatile state', () => {
    const b = bench();
    b.dtr0(60); b.cfg(S5, 0x2d);
    b.tx(D5, 200); b.tx(0xa5, 0); b.tx(0xa5, 0);
    expect(b.s.init).toBe('enabled');
    b.g.powerCycle();
    expect(b.s.actualLevel).toBe(60);
    expect(b.s.init).toBe('disabled');
    expect(b.s.powerFailure).toBe(true);
    expect(b.s.powerOnLevel).toBe(60);            // persistent
  });
  it('power-on level MASK recalls the last active level', () => {
    const b = bench();
    b.dtr0(255); b.cfg(S5, 0x2d);
    b.tx(D5, 80); b.g.powerCycle();
    expect(b.s.actualLevel).toBe(80);
  });
  it('IDENTIFY DEVICE is shown for 10 s', () => {
    const b = bench();
    b.cfg(S5, 0x25);
    expect(b.s.identifyUntilUs).toBeGreaterThan(0);
    b.advance(10_001);
    expect(b.s.identifyUntilUs).toBe(0);
  });
});

describe('initialisation and addressing protocol', () => {
  const init = (b: ReturnType<typeof bench>, d = 0) => { b.tx(0xa5, d); b.tx(0xa5, d); };
  const setSearch = (b: ReturnType<typeof bench>, v: number) => {
    b.tx(0xb1, (v >> 16) & 255); b.tx(0xb3, (v >> 8) & 255); b.tx(0xb5, v & 255);
  };

  it('INITIALISE needs send-twice and honours its address filter', () => {
    const b = bench({ shortAddress: 5 });
    b.tx(0xa5, 0); expect(b.s.init).toBe('disabled');
    init(b, 0); expect(b.s.init).toBe('enabled');
    b.tx(0xa1, 0); expect(b.s.init).toBe('disabled');          // TERMINATE
    init(b, 0xff); expect(b.s.init).toBe('disabled');          // only unaddressed gear
    init(b, (6 << 1) | 1); expect(b.s.init).toBe('disabled');  // other gear
    init(b, (5 << 1) | 1); expect(b.s.init).toBe('enabled');
    const u = bench({ shortAddress: null });
    init(u, 0xff); expect(u.s.init).toBe('enabled');
  });
  it('the initialisation state expires after 15 minutes', () => {
    const b = bench();
    init(b);
    b.advance(14 * 60_000); expect(b.s.init).toBe('enabled');
    b.advance(61_000); expect(b.s.init).toBe('disabled');
  });
  it('RANDOMISE, COMPARE, WITHDRAW', () => {
    const b = bench();
    expect(b.tx(0xa9, 0)).toBeUndefined();                  // not initialised
    init(b);
    b.tx(0xa7, 0); b.tx(0xa7, 0);
    const r = b.s.randomAddress;
    expect(r).not.toBe(0xffffff);
    setSearch(b, r); expect(b.tx(0xa9, 0)).toBe(255);       // equal
    setSearch(b, r + 1); expect(b.tx(0xa9, 0)).toBe(255);   // greater
    setSearch(b, r - 1); expect(b.tx(0xa9, 0)).toBeUndefined();
    setSearch(b, r); b.tx(0xab, 0);
    expect(b.s.init).toBe('withdrawn');
    expect(b.tx(0xa9, 0)).toBeUndefined();                  // withdrawn gear stays quiet
  });
  it('RANDOMISE also needs send-twice', () => {
    const b = bench(); init(b);
    b.tx(0xa7, 0);
    expect(b.s.randomAddress).toBe(0xffffff);
  });
  it('PROGRAM / VERIFY / QUERY SHORT ADDRESS only act on the selected gear', () => {
    const b = bench({ shortAddress: null });
    init(b, 0xff); b.tx(0xa7, 0); b.tx(0xa7, 0);
    const r = b.s.randomAddress;
    setSearch(b, r - 1);
    b.tx(0xb7, (9 << 1) | 1); expect(b.s.shortAddress).toBeNull();     // not selected
    setSearch(b, r);
    expect(b.tx(0xbb, 0)).toBe(255);                                   // selected, no address yet
    b.tx(0xb7, (9 << 1) | 1);
    expect(b.s.shortAddress).toBe(9);
    expect(b.tx(0xbb, 0)).toBe((9 << 1) | 1);
    expect(b.tx(0xb9, (9 << 1) | 1)).toBe(255);
    expect(b.tx(0xb9, (8 << 1) | 1)).toBeUndefined();
    b.tx(0xb7, 0xff); expect(b.s.shortAddress).toBeNull();             // delete
  });
  it('commissioning commands are ignored outside the initialisation state', () => {
    const b = bench({ shortAddress: null });
    setSearch(b, 0); expect(b.s.searchAddress).toBe(0xffffff);
  });
});

describe('Simulation', () => {
  const frame = (sim: Simulation, a: number, d: number, t = 0): SimReply =>
    sim.process(Uint8Array.of(a, d), 16, { busUs: t, simUs: t });

  it('enforces the gear limit', () => {
    const sim = new Simulation({ maxGears: 65 });
    sim.addGears(65);
    expect(sim.gears).toHaveLength(65);
    expect(() => sim.addGear()).toThrow(/65/);
    expect(new Simulation({ maxGears: 2 }).addGears(2)).toHaveLength(2);
  });
  it('gives gears unique ids that survive removals', () => {
    const sim = new Simulation();
    const [a, b, c] = sim.addGears(3);
    sim.removeGear(b!.id);
    expect(sim.gears.map((g) => g.id)).toEqual([a!.id, c!.id]);
    expect(sim.addGear().id).toBe(3);
    expect(sim.removeGear(99)).toBe(false);
  });
  it('combines answers: identical = valid frame, different = collision, none', () => {
    const sim = new Simulation();
    const gs = sim.addGears(3, {}, 0);
    expect(frame(sim, 0xff, 0xa0)).toEqual({ kind: 'answer', byte: 254 });
    gs[1]!.forceLevel(100);
    expect(frame(sim, 0xff, 0xa0)).toEqual({ kind: 'collision' });
    expect(frame(sim, 0x03, 0xa0)).toEqual({ kind: 'answer', byte: 100 });   // short address 1
    expect(frame(sim, 0x7f, 0xa0)).toEqual({ kind: 'none' });                // short 63: nobody
  });
  it('reports what changed since the last look', () => {
    const sim = new Simulation();
    const g = sim.addGear({ shortAddress: 0 });
    expect(sim.consumeChanges()).toEqual({ ids: [], structural: true });
    frame(sim, 0x00, 50);
    expect(sim.consumeChanges()).toEqual({ ids: [g.id], structural: false });
    expect(sim.consumeChanges()).toEqual({ ids: [], structural: false });
  });
  it('advance animates fades and tells whether it needs ticking', () => {
    const sim = new Simulation();
    const g = sim.addGear({ shortAddress: 0 });
    g.s.fadeTime = 4;
    frame(sim, 0x00, 0, 0);
    frame(sim, 0x00, 200, 0);
    expect(sim.animating).toBe(true);
    expect(sim.advance(1_000_000)).toBe(true);
    expect(g.s.actualLevel).toBeGreaterThan(90);
    sim.advance(3_000_000);
    expect(sim.animating).toBe(false);
    expect(g.s.actualLevel).toBe(200);
  });
  it('snapshots are independent copies', () => {
    const sim = new Simulation();
    const g = sim.addGear({ shortAddress: 0 });
    const snap = sim.snapshot();
    g.forceLevel(10);
    expect(snap[0]!.state.actualLevel).toBe(254);
    expect(sim.snapshot()[0]!.state.actualLevel).toBe(10);
  });
});

describe('commissioning', () => {
  /** Controller I/O directly on a Simulation; 20 ms between frames, like a real bus. */
  function ioFor(sim: Simulation): CommissioningIo & { frames: number } {
    let t = 0;
    const io = {
      frames: 0,
      send(f: [number, number], twice = false) {
        for (let i = 0; i < (twice ? 2 : 1); i++) {
          t += 20_000; io.frames++;
          sim.process(Uint8Array.from(f), 16, { busUs: t, simUs: t });
        }
      },
      query(f: [number, number]) {
        t += 20_000; io.frames++;
        const r = sim.process(Uint8Array.from(f), 16, { busUs: t, simUs: t });
        return r.kind === 'answer' ? r.byte : r.kind === 'collision' ? 255 : null;
      }
    };
    return io;
  }

  it('assigns unique addresses 0-63 to 64 unaddressed gears', async () => {
    const sim = new Simulation({ rng: seeded(42) });
    sim.addGears(64);
    const res = await commissionBus(ioFor(sim));
    expect(res.assigned).toBe(64);
    const addrs = sim.gears.map((g) => g.s.shortAddress);
    expect(new Set(addrs).size).toBe(64);
    expect([...addrs].sort((a, b) => a! - b!)).toEqual(Array.from({ length: 64 }, (_, i) => i));
    expect(sim.gears.every((g) => g.s.init === 'disabled')).toBe(true);   // TERMINATE
  });
  it('65 gears: 64 get addresses, one stays unaddressed', async () => {
    const sim = new Simulation({ rng: seeded(7) });
    sim.addGears(65);
    const res = await commissionBus(ioFor(sim));
    expect(res.assigned).toBe(64);
    expect(sim.gears.filter((g) => g.s.shortAddress === null)).toHaveLength(1);
  });
  it('re-addresses only unaddressed gear by default and keeps existing addresses', async () => {
    const sim = new Simulation({ rng: seeded(3) });
    sim.addGears(2, {}, 10);       // addressed 10, 11
    sim.addGears(3);               // unaddressed
    const res = await commissionBus(ioFor(sim), { firstAddress: 0 });
    expect(res.assigned).toBe(3);
    expect(sim.gears.slice(0, 2).map((g) => g.s.shortAddress)).toEqual([10, 11]);
    expect(sim.gears.slice(2).map((g) => g.s.shortAddress).sort()).toEqual([0, 1, 2]);
  });
  it('`all` re-addresses everything', async () => {
    const sim = new Simulation({ rng: seeded(5) });
    sim.addGears(4, {}, 20);
    const res = await commissionBus(ioFor(sim), { all: true });
    expect(res.assigned).toBe(4);
    expect(sim.gears.map((g) => g.s.shortAddress).sort()).toEqual([0, 1, 2, 3]);
  });
  it('an empty bus finishes quickly', async () => {
    const res = await commissionBus(ioFor(new Simulation()));
    expect(res.assigned).toBe(0);
    expect(res.frames).toBeLessThan(10);
  });
  it('an offline gear is not addressed', async () => {
    const sim = new Simulation({ rng: seeded(9) });
    sim.addGears(3);
    sim.gears[1]!.setFault({ offline: true });
    const res = await commissionBus(ioFor(sim));
    expect(res.assigned).toBe(2);
    expect(sim.gears[1]!.s.shortAddress).toBeNull();
  });
  it('respects maxAddresses', async () => {
    const sim = new Simulation({ rng: seeded(11) });
    sim.addGears(6);
    expect((await commissionBus(ioFor(sim), { maxAddresses: 4 })).assigned).toBe(4);
  });
});
