import { describe, expect, it } from 'vitest';
import { CaptureSession, Decoder, levelToPercent, makeFrame, percentToLevel, parseCapture, serializeCapture } from '../src/index.js';

const dec = (hex: string, d = new Decoder()) => d.decode(makeFrame(hex));

describe('level curve', () => {
  it('maps endpoints', () => {
    expect(levelToPercent(0)).toBe(0);
    expect(levelToPercent(254)).toBe(100);
    expect(levelToPercent(1)).toBeCloseTo(0.1, 5);
    expect(levelToPercent(128)).toBeCloseTo(3.2057, 3);
  });
  it('round trips', () => {
    for (let l = 1; l <= 254; l++) expect(percentToLevel(levelToPercent(l))).toBe(l);
  });
});

describe('address byte matrix', () => {
  it.each([
    ['00 80', 'Short 0'], ['0A 80', 'Short 5'], ['7E 80', 'Short 63'],
    ['80 80', 'Group 0'], ['9E 80', 'Group 15'], ['FE 80', 'Broadcast'],
    ['FC 80', 'Broadcast unaddressed']
  ])('%s -> %s (DAPC)', (hex, target) => {
    const r = dec(hex);
    expect(r.target).toBe(target);
    expect(r.class).toBe('arc');
    expect(r.command).toBe('DAPC');
  });
  it('S bit selects command', () => {
    expect(dec('0B 00').command).toBe('OFF'); // short 5, S=1
    expect(dec('0B 00').target).toBe('Short 5');
  });
});

describe('standard commands', () => {
  it('DAPC shows percent and MASK', () => {
    expect(dec('0A 80').summary).toBe('Short 5 · DAPC 128 (3.21 %)');
    expect(dec('FE FF').summary).toContain('MASK');
    expect(dec('FE 00').summary).toContain('OFF');
  });
  it('indexed commands expose the offset', () => {
    expect(dec('0B 14').command).toBe('GO TO SCENE 4');
    expect(dec('0B 6F').command).toBe('ADD TO GROUP 15');
  });
  it('flags send-twice and uses DTR0', () => {
    const d = new Decoder();
    d.decode(makeFrame('A3 C8')); // DTR0 = 200
    const r = d.decode(makeFrame('87 44')); // group 3 (0x87: 100 0011 1) -> SET SCENE 4
    expect(r.target).toBe('Group 3');
    expect(r.command).toBe('SET SCENE 4');
    expect(r.sendTwice).toBe(true);
    expect(r.params[0]).toMatch(/^DTR0=200 \(/);
  });
  it('reports unknown DTR0', () => {
    expect(dec('87 44').params).toEqual(['DTR0=?']);
  });
  it('unknown commands are kept and flagged', () => {
    const r = dec('0B 2C'.replace('2C', 'D0'));
    expect(r.unknown).toBe(true);
    expect(r.class).toBe('unknown');
  });
});

describe('special commands', () => {
  it('decodes commissioning set', () => {
    expect(dec('A5 00').summary).toBe('Special · INITIALISE all gear');
    expect(dec('A5 FF').params[0]).toBe('unaddressed gear only');
    expect(dec('A5 0B').params[0]).toBe('short address 5');
    expect(dec('A7 00').command).toBe('RANDOMISE');
    expect(dec('B7 0B').summary).toContain('short address 5');
    expect(dec('B7 FF').params[0]).toBe('delete short address');
    expect(dec('AD 00').command).toBe('PING');
  });
  it('tracks DTR1/DTR2', () => {
    const d = new Decoder();
    d.decode(makeFrame('C3 0F'));
    d.decode(makeFrame('C5 A0'));
    expect(d.dtr1).toBe(0x0f);
    expect(d.dtr2).toBe(0xa0);
  });
  it('even bytes in the special range are reserved', () => {
    expect(dec('A2 00').unknown).toBe(true);
  });
});

describe('device type extension', () => {
  it('resolves extended commands after ENABLE DEVICE TYPE', () => {
    const d = new Decoder();
    d.decode(makeFrame('C1 08'));
    const r = d.decode(makeFrame('0B E2'));
    expect(r.class).toBe('extended');
    expect(r.command).toBe('DT8 EXTENDED COMMAND');
  });
  it('enable DT applies to one frame only', () => {
    const d = new Decoder();
    d.decode(makeFrame('C1 08'));
    d.decode(makeFrame('0B E2'));
    const r = d.decode(makeFrame('0B E2'));
    expect(r.class).toBe('unknown');
    expect(r.warnings[0]).toMatch(/ENABLE DEVICE TYPE/);
  });
});

describe('odd frames', () => {
  it('24-bit control device frames are shown raw', () => {
    const r = dec('01 02 03');
    expect(r.layer).toBe('103');
    expect(r.unknown).toBe(true);
  });
  it('unsupported length', () => {
    const r = new Decoder().decode(makeFrame('FF', { bits: 12 }));
    expect(r.unknown).toBe(true);
  });
  it('error frames', () => {
    const r = new Decoder().decode(makeFrame('', { kind: 'error', error: 'collision', bits: 0 }));
    expect(r.class).toBe('error');
  });
});

describe('answer correlation', () => {
  const t = (us: number, hex: string, o = {}) => makeFrame(hex, { ts: us, ...o });
  it('links answer to query', () => {
    const s = new CaptureSession();
    const q = s.push(t(0, '0B A0'));
    const a = s.push(t(5000, 'FE'));
    expect(q.decoded.command).toBe('QUERY ACTUAL LEVEL');
    expect(q.answerStatus).toBe('answered');
    expect(q.answerSeq).toBe(a.seq);
    expect(q.decoded.answer).toMatch(/^254 \(100\.0 %\)$/);
    expect(a.decoded.answerTo).toBe(q.seq);
  });
  it('marks unanswered queries', () => {
    const s = new CaptureSession();
    const q = s.push(t(0, '0B 91'));
    s.push(t(100000, '0B 00'));
    expect(q.answerStatus).toBe('none');
  });
  it('decodes status bits and yes/no', () => {
    const s = new CaptureSession();
    s.push(t(0, '0B 90'));
    const a = s.push(t(5000, '06'));
    expect(s.at(0)!.decoded.answer).toBe('0x06 (lamp failure, lamp arc power on)');
    expect(a.decoded.class).toBe('answer');
    s.push(t(9e4, 'A9 00'));
    s.push(t(9.5e4, 'FF'));
    expect(s.at(2)!.decoded.answer).toBe('YES');
  });
  it('stray backward frame is flagged', () => {
    const s = new CaptureSession();
    const a = s.push(t(0, 'AA'));
    expect(a.decoded.warnings.length).toBe(1);
  });
  it('computes deltas and trims ring buffer', () => {
    const s = new CaptureSession(2);
    s.push(t(0, '0B 00')); s.push(t(1000, '0B 00')); const r = s.push(t(4000, '0B 00'));
    expect(r.deltaUs).toBe(3000);
    expect(s.length).toBe(2);
    expect(s.firstSeq).toBe(1);
  });
});

describe('capture file', () => {
  it('round trips', () => {
    const frames = [makeFrame('0B A0', { ts: 10, dir: 'tx' }), makeFrame('FE', { ts: 5010 })];
    const back = parseCapture(serializeCapture(frames));
    expect(back).toHaveLength(2);
    expect(back[0]!.dir).toBe('tx');
    expect(back[1]!.kind).toBe('backward');
    expect(Array.from(back[1]!.data)).toEqual([0xfe]);
  });
  it('rejects foreign files', () => {
    expect(() => parseCapture('{"hello":1}')).toThrow(/dscap/);
  });
});
