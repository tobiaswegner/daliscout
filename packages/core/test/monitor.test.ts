import { describe, expect, it } from 'vitest';
import {
  CaptureSession, StatsTracker, buildCommand, buildDapc, buildSpecial, compileFilter, encodeAddressByte,
  frameDurationUs, isEmptyFilter, makeFrame, parseHexInput, rowsToCsv, rowsToText, Decoder, toHex,
  type RowFilter
} from '../src/index.js';

const capture = () => {
  const s = new CaptureSession();
  const t = (ts: number, hex: string, o = {}) => s.push(makeFrame(hex, { ts, ...o }));
  t(0, '0A 80');                    // 0 short 5 DAPC 128
  t(30_000, '0B A0');               // 1 short 5 query actual level
  t(35_000, 'FE');                  // 2 answer 254
  t(1_000_000, '87 44');            // 3 group 3 SET SCENE 4
  t(1_100_000, '0D 91');            // 4 short 6 query present, unanswered
  t(2_000_000, 'FE 00', { dir: 'tx' }); // 5 broadcast DAPC 0 (tx)
  t(2_500_000, '', { kind: 'error', error: 'collision', bits: 0 }); // 6
  return s;
};
const run = (f: RowFilter) => {
  const s = capture();
  const { match, error } = compileFilter(f, s.at(0)!.frame.ts);
  return { seqs: s.all().filter(match).map((r) => r.seq), error };
};

describe('decoder address/level fields', () => {
  it('exposes structured addresses and levels', () => {
    const d = new Decoder();
    expect(d.decode(makeFrame('0A 80')).addr).toEqual({ kind: 'short', value: 5 });
    expect(d.decode(makeFrame('0A 80')).level).toBe(128);
    expect(d.decode(makeFrame('FE FF')).level).toBeUndefined();
    expect(d.decode(makeFrame('9E 80')).addr).toEqual({ kind: 'group', value: 15 });
    expect(d.decode(makeFrame('A5 00')).addr).toEqual({ kind: 'special' });
  });
  it('answers inherit the address and level of the query', () => {
    const s = capture();
    expect(s.at(2)!.decoded.addr).toEqual({ kind: 'short', value: 5 });
    expect(s.at(2)!.decoded.level).toBe(254);
  });
  it('SET commands expose the DTR0 level', () => {
    const d = new Decoder();
    d.decode(makeFrame('A3 C8'));
    expect(d.decode(makeFrame('87 44')).level).toBe(200);
  });
});

describe('filters', () => {
  it('empty filter matches all', () => {
    expect(isEmptyFilter({})).toBe(true);
    expect(run({}).seqs).toHaveLength(7);
  });
  it('plain text needs all terms', () => {
    expect(run({ text: 'short 5' }).seqs).toEqual([0, 1]); // the reply row's target is "Gear"
    expect(run({ text: 'short 5 dapc' }).seqs).toEqual([0]);
  });
  it('regex mode and invalid regex', () => {
    expect(run({ text: '^.*scene \\d+', regex: true }).seqs).toEqual([3]);
    const bad = run({ text: '(', regex: true });
    expect(bad.error).toBeTruthy();
    expect(bad.seqs).toEqual([]);
  });
  it('direction, class, command', () => {
    expect(run({ dirs: ['tx'] }).seqs).toEqual([5]);
    expect(run({ classes: ['query'] }).seqs).toEqual([1, 4]);
    expect(run({ command: 'dapc' }).seqs).toEqual([0, 5]);
  });
  it('address filter follows the conversation including answers', () => {
    expect(run({ addrKind: 'short', addrValue: 5 }).seqs).toEqual([0, 1, 2]);
    expect(run({ addrKind: 'group' }).seqs).toEqual([3]);
    expect(run({ addrKind: 'broadcast' }).seqs).toEqual([5]);
  });
  it('answer status', () => {
    expect(run({ answer: 'answered' }).seqs).toEqual([1]);
    expect(run({ answer: 'none' }).seqs).toEqual([4]);
  });
  it('errors only / unknown only', () => {
    expect(run({ errorsOnly: true }).seqs).toEqual([6]);
    expect(run({ unknownOnly: true }).seqs).toEqual([6]);
  });
  it('level range', () => {
    expect(run({ levelMin: 100, levelMax: 200 }).seqs).toEqual([0]);
    expect(run({ levelMin: 250 }).seqs).toEqual([2]);
    expect(run({ levelMax: 0 }).seqs).toEqual([5]);
  });
  it('time window is relative to first frame', () => {
    expect(run({ fromS: 1, toS: 1.5 }).seqs).toEqual([3, 4]);
  });
  it('combines with AND', () => {
    expect(run({ text: 'short', classes: ['arc'] }).seqs).toEqual([0]);
  });
});

describe('export', () => {
  it('csv quotes and has a header', () => {
    const csv = rowsToCsv(capture().all());
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('seq,time_s,delta_ms,dir,bits,hex,target,command,parameters,answer,summary,warnings');
    expect(lines).toHaveLength(8);
    expect(lines[2]).toContain('QUERY ACTUAL LEVEL');
    expect(lines[2]).toContain('254 (100.0 %)');
    expect(lines[6]).toContain(',tx,');
  });
  it('csv escapes commas, quotes and newlines', () => {
    const s = new CaptureSession();
    s.push(makeFrame('0B 00', { ts: 0 }));
    s.at(0)!.decoded.params = ['a,b', 'say "hi"'];
    expect(rowsToCsv(s.all())).toContain('"a,b; say ""hi"""');
  });
  it('text log shows answers and warnings', () => {
    const txt = rowsToText(capture().all());
    expect(txt).toContain('=> 254 (100.0 %)');
    expect(txt).toContain('!!');
    expect(txt.endsWith('\n')).toBe(true);
    expect(rowsToText([])).toBe('');
  });
});

describe('statistics', () => {
  it('computes frame duration', () => {
    expect(frameDurationUs(16)).toBeCloseTo(15833.3, 0);
    expect(frameDurationUs(8)).toBeCloseTo(9166.7, 0);
  });
  it('counts and per-address totals', () => {
    const s = capture();
    const st = new StatsTracker();
    s.all().forEach((r) => st.add(r));
    const snap = st.snapshot(s.unanswered);
    expect(snap).toMatchObject({ total: 7, forward: 5, backward: 1, errors: 1, unanswered: 1 });
    expect(snap.perAddress[0]).toEqual({ label: 'Short 5', count: 2 });
  });
  it('bus load over the trailing window', () => {
    const st = new StatsTracker(1_000_000);
    const s = new CaptureSession();
    for (let i = 0; i < 10; i++) st.add(s.push(makeFrame('FE 00', { ts: i * 100_000 })));
    const snap = st.snapshot();
    expect(snap.framesPerSecond).toBe(10);
    expect(snap.busLoad).toBeCloseTo(10 * 15833.3 / 1e6, 2);
    st.add(s.push(makeFrame('FE 00', { ts: 10_000_000 }))); // old frames fall out of the window
    expect(st.snapshot().framesPerSecond).toBe(1);
  });
});

describe('frame builder', () => {
  it.each([
    [{ kind: 'short', value: 5 }, false, 0x0a], [{ kind: 'short', value: 5 }, true, 0x0b],
    [{ kind: 'group', value: 15 }, true, 0x9f], [{ kind: 'broadcast' }, false, 0xfe],
    [{ kind: 'broadcast-unaddressed' }, true, 0xfd]
  ] as const)('%j S=%s -> %i', (t, s, byte) => {
    expect(encodeAddressByte(t, s)).toBe(byte);
  });
  it('rejects out-of-range values', () => {
    expect(() => encodeAddressByte({ kind: 'short', value: 64 }, true)).toThrow(RangeError);
    expect(() => encodeAddressByte({ kind: 'group', value: 16 }, true)).toThrow(RangeError);
    expect(() => buildDapc({ kind: 'broadcast' }, 256)).toThrow(RangeError);
  });
  it('round-trips through the decoder', () => {
    const d = new Decoder();
    expect(d.decode(makeFrame(toHex(buildDapc({ kind: 'short', value: 3 }, 100)))).summary).toContain('Short 3 · DAPC 100');
    expect(d.decode(makeFrame(toHex(buildCommand({ kind: 'group', value: 2 }, 0x14)))).command).toBe('GO TO SCENE 4');
    expect(d.decode(makeFrame(toHex(buildSpecial(0xa5, 0)))).command).toBe('INITIALISE');
  });
  it('parses user hex', () => {
    expect(Array.from(parseHexInput('0xFF, 0x90'))).toEqual([0xff, 0x90]);
    expect(Array.from(parseHexInput('ff90'))).toEqual([0xff, 0x90]);
    expect(() => parseHexInput('f')).toThrow();
  });
});
