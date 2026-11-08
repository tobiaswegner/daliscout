import { type BusFrame, fromHex, toHex } from './frame.js';

/** Native capture format `.dscap`: JSON Lines, header line first. */
const HEADER = { format: 'dscap', version: 1 };

export function serializeCapture(frames: readonly BusFrame[]): string {
  const lines = [JSON.stringify(HEADER)];
  for (const f of frames) {
    lines.push(JSON.stringify({
      t: f.ts, d: f.dir, k: f.kind, b: f.bits, h: toHex(f.data), e: f.error, s: f.source
    }));
  }
  return lines.join('\n') + '\n';
}

export function parseCapture(text: string): BusFrame[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const head = JSON.parse(lines[0]!);
  if (head.format !== 'dscap') throw new Error('Not a .dscap capture file');
  if (head.version !== 1) throw new Error(`Unsupported .dscap version ${head.version}`);
  return lines.slice(1).map((l, i) => {
    try {
      const o = JSON.parse(l);
      const data = fromHex(o.h ?? '');
      return {
        ts: o.t, dir: o.d, kind: o.k, bits: o.b ?? data.length * 8,
        data, error: o.e, source: o.s ?? 'file'
      } as BusFrame;
    } catch (e) {
      throw new Error(`Invalid capture line ${i + 2}: ${(e as Error).message}`);
    }
  });
}
