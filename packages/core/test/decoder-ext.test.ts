import { describe, expect, it } from 'vitest';
import { Decoder, makeFrame, type Decoded } from '../src/index.js';

function run(frames: string[]): Decoded[] {
  const d = new Decoder();
  return frames.map((h, i) => d.decode(makeFrame(h, { ts: i * 20_000 }), i));
}

describe('DT8 extended decoding', () => {
  it('names the command and interprets the DTRs', () => {
    const r = run(['A3 00', 'C3 80', 'C1 08', '0B E0']);
    expect(r[3]!.command).toBe('DT8 SET TEMPORARY X-COORDINATE');
    expect(r[3]!.params).toEqual(['x=0.5000 (0x8000)']);
    expect(r[3]!.class).toBe('extended');
  });
  it('Tc in mirek and kelvin', () => {
    const r = run(['A3 FA', 'C3 00', 'C1 08', '0B E7']);
    expect(r[3]!.params).toEqual(['250 mirek = 4000 K']);
  });
  it('RGB, primary and control', () => {
    const r = run(['A3 FF', 'C3 80', 'C5 00', 'C1 08', '0B EB', 'C1 08', '0B EA']);
    expect(r[4]!.params).toEqual(['R=255', 'G=128', 'B=0']);
    expect(r[6]!.params[0]).toBe('primary 0');
  });
  it('marks configuration commands as send-twice and queries as queries with answers', () => {
    const r = run(['C1 08', '0B F4', 'C1 08', '0B F9', '77']);
    expect(r[1]!.sendTwice).toBe(true);
    expect(r[3]!.class).toBe('query');
    expect(r[3]!.expectsAnswer).toBe(true);
    expect(r[4]!.summary).toContain('xy, Tc, 5 primaries, 3 RGBWAF channels');
    expect(r[4]!.answerTo).toBe(3);
  });
  it('colour status answer', () => {
    const r = run(['C1 08', '0B F8', '21']);
    expect(r[2]!.summary).toContain('xy out of range');
    expect(r[2]!.summary).toContain('Tc active');
  });
  it('query colour value shows which register is read', () => {
    const r = run(['A3 82', 'C1 08', '0B FA']);
    expect(r[2]!.params).toEqual(['temporary Tc']);
    expect(run(['A3 C0', 'C1 08', '0B FA'])[2]!.params).toEqual(['report X']);
  });
  it('without ENABLE DEVICE TYPE the opcode stays unknown; ENABLE applies to one frame only', () => {
    const r = run(['0B E0', 'C1 08', '0B 90', '0B E0']);
    expect(r[0]!.unknown).toBe(true);
    expect(r[2]!.command).toBe('QUERY STATUS');
    expect(r[3]!.unknown).toBe(true);
  });
  it('unlisted DT8 opcodes still decode generically', () => {
    const r = run(['C1 08', '0B E9']);
    expect(r[1]!.command).toBe('DT8 COLOUR TEMPERATURE Tc WARMER');
    const u = run(['C1 08', '0B F6']);
    expect(u[1]!.command).toBe('DT8 EXTENDED COMMAND');
  });
});

describe('DT0 extended decoding', () => {
  it('names DT0 commands', () => {
    const r = run(['A3 01', 'C1 00', '0B E3', 'C1 00', '0B EE', '01']);
    expect(r[2]!.command).toBe('DT0 SELECT DIMMING CURVE');
    expect(r[2]!.params).toEqual(['linear']);
    expect(r[2]!.sendTwice).toBe(true);
    expect(r[4]!.command).toBe('DT0 QUERY DIMMING CURVE');
  });
  it('fast fade time in milliseconds', () => {
    const r = run(['A3 0C', 'C1 00', '0B E4']);
    expect(r[2]!.params).toEqual(['300 ms']);
  });
});
