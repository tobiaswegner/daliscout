/** A single telegram observed on (or sent to) the bus. */
export type FrameKind = 'forward' | 'backward' | 'error';
export type FrameDir = 'rx' | 'tx';
export type FrameError = 'framing' | 'collision' | 'short' | 'long';

export interface BusFrame {
  /** Monotonic timestamp in microseconds (number, not bigint, so it survives IPC/JSON). */
  ts: number;
  dir: FrameDir;
  kind: FrameKind;
  /** Number of bits on the wire (8 backward, 16 gear forward, 24 control device, ...). */
  bits: number;
  data: Uint8Array;
  error?: FrameError;
  /** Origin: transport id, or 'sim' for simulator-generated frames. */
  source: string;
}

export function toHex(data: Uint8Array, sep = ' '): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(sep);
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error(`Odd number of hex digits: "${hex}"`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function makeFrame(
  hex: string,
  opts: Partial<Omit<BusFrame, 'data'>> = {}
): BusFrame {
  const data = fromHex(hex);
  const bits = opts.bits ?? data.length * 8;
  const kind: FrameKind = opts.kind ?? (bits === 8 ? 'backward' : 'forward');
  return { ts: 0, dir: 'rx', source: 'test', ...opts, kind, bits, data };
}
