/** Colour maths for DT8 gear and its visualisation. Pure functions, no state. */

export type Rgb = [number, number, number];
export interface Xy { x: number; y: number }

/** Colour temperature in mirek (micro reciprocal kelvin) <-> kelvin. */
export const mirekToKelvin = (m: number): number => (m <= 0 ? Infinity : 1_000_000 / m);
export const kelvinToMirek = (k: number): number => Math.round(1_000_000 / k);

/**
 * CIE xy of a black-body radiator, Kim et al. cubic spline approximation of the Planckian locus
 * (valid 1667..25000 K; input is clamped).
 */
export function kelvinToXy(kelvin: number): Xy {
  const T = Math.min(25000, Math.max(1667, kelvin));
  const T2 = T * T, T3 = T2 * T;
  const x = T <= 4000
    ? -0.2661239e9 / T3 - 0.2343589e6 / T2 + 0.8776956e3 / T + 0.17991
    : -3.0258469e9 / T3 + 2.1070379e6 / T2 + 0.2226347e3 / T + 0.24039;
  const x2 = x * x, x3 = x2 * x;
  const y = T <= 2222
    ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
    : T <= 4000
      ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return { x, y };
}
export const mirekToXy = (mirek: number): Xy => kelvinToXy(mirekToKelvin(mirek));

const encode = (c: number): number => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
};

/** Linear sRGB (may be negative / > 1) for XYZ. */
const xyzToLinear = (X: number, Y: number, Z: number): Rgb => [
  3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
  -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
  0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z
];

/** Linear RGB -> display sRGB: out-of-gamut channels are clipped, brightest channel scaled to 1. */
function linearToDisplay(lin: Rgb): Rgb {
  const c = lin.map((v) => Math.max(0, v)) as Rgb;
  const max = Math.max(...c);
  if (max <= 0) return [0, 0, 0];
  return c.map((v) => encode(v / max)) as Rgb;
}

/** Colour of an xy chromaticity at full brightness, as sRGB (gamut-clipped). */
export function xyToRgb(x: number, y: number): Rgb {
  if (y <= 0) return [0, 0, 0];
  return linearToDisplay(xyzToLinear(x / y, 1, (1 - x - y) / y));
}

/** True when xy lies inside the sRGB gamut triangle (used as the "xy in range" test of the sim). */
export function xyInGamut(x: number, y: number): boolean {
  if (y <= 0) return false;
  const [r, g, b] = xyzToLinear(x / y, 1, (1 - x - y) / y);
  return r >= -1e-6 && g >= -1e-6 && b >= -1e-6;
}

/** Linear-light RGB vector of one primary, scaled so its strongest channel is 1 (out-of-gamut clipped). */
function primaryVector(p: Xy): Rgb {
  if (p.y <= 0) return [0, 0, 0];
  const lin = xyzToLinear(p.x / p.y, 1, (1 - p.x - p.y) / p.y).map((v) => Math.max(0, v)) as Rgb;
  const max = Math.max(...lin);
  return max > 0 ? (lin.map((v) => v / max) as Rgb) : [0, 0, 0];
}

/**
 * Additive mix of primaries with the given chromaticities. `levels` are 0..1 relative drive of
 * each primary at equal radiant flux. Returns the display colour at full brightness (hue only).
 */
export function mixPrimaries(primaries: readonly Xy[], levels: readonly number[]): Rgb {
  const sum: Rgb = [0, 0, 0];
  for (let i = 0; i < primaries.length; i++) {
    const l = levels[i] ?? 0;
    if (l <= 0) continue;
    const v = primaryVector(primaries[i]!);
    for (let k = 0; k < 3; k++) sum[k]! += l * v[k]!;
  }
  const max = Math.max(...sum);
  if (max <= 0) return [0, 0, 0];
  return sum.map((v) => encode(v / max)) as Rgb;
}
