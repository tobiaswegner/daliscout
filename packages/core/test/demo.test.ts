import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CaptureSession, parseCapture } from '../src/index.js';

describe('examples/demo.dscap', () => {
  const frames = parseCapture(readFileSync(new URL('../../../examples/demo.dscap', import.meta.url), 'utf8'));
  const s = new CaptureSession();
  frames.forEach((f) => s.push(f));
  const rows = s.all();

  it('only the deliberate garbage is unknown (error frame + 24-bit frame)', () => {
    const unknown = rows.filter((r) => r.decoded.unknown).map((r) => r.decoded.command);
    expect(unknown).toEqual(['BUS ERROR', 'CONTROL DEVICE FRAME']);
  });

  it('correlates answers and flags unanswered queries', () => {
    const q = rows.filter((r) => r.decoded.expectsAnswer);
    expect(q.filter((r) => r.answerStatus === 'answered').length).toBeGreaterThanOrEqual(7);
    expect(q.filter((r) => r.answerStatus === 'none').length).toBeGreaterThanOrEqual(3);
    expect(q.every((r) => r.answerStatus !== 'pending')).toBe(true);
  });

  it('resolves DT8 extended commands', () => {
    expect(rows.some((r) => r.decoded.command.startsWith('DT8 '))).toBe(true);
  });
});
