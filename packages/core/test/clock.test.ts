import { describe, expect, it } from 'vitest';
import { SimClock } from '../src/index.js';

describe('SimClock', () => {
  const make = () => { let h = 1000; const c = new SimClock(() => h); return { c, step: (us: number) => { h += us; } }; };

  it('starts at zero and follows the host clock', () => {
    const { c, step } = make();
    expect(c.now()).toBe(0);
    step(500); expect(c.now()).toBe(500);
  });
  it('scales by speed and settles time at the old speed first', () => {
    const { c, step } = make();
    step(1000); c.setSpeed(10);
    expect(c.now()).toBe(1000);
    step(1000); expect(c.now()).toBe(11_000);
    c.setSpeed(0.5); step(1000); expect(c.now()).toBe(11_500);
  });
  it('pauses and resumes without losing or gaining time', () => {
    const { c, step } = make();
    step(1000); c.pause();
    step(5000); expect(c.now()).toBe(1000);
    expect(c.paused).toBe(true);
    c.resume(); step(200); expect(c.now()).toBe(1200);
  });
  it('rejects invalid speeds', () => {
    const { c } = make();
    for (const v of [0, -1, NaN, Infinity]) expect(() => c.setSpeed(v)).toThrow(RangeError);
  });
});
