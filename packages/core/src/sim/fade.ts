/** DALI fade tables (IEC 62386-102). */

/** Fade time in seconds for fade time number 0..15 (0 = no fade). */
export const fadeTimeSeconds = (n: number): number => (n <= 0 ? 0 : 0.5 * Math.SQRT2 ** Math.min(n, 15));

/** Fade rate in level steps per second for fade rate number 1..15. */
export const fadeRateStepsPerSecond = (n: number): number => 506 / Math.SQRT2 ** Math.min(Math.max(n, 1), 15);

const EXTENDED_UNIT_US = [0, 100_000, 1_000_000, 10_000_000, 60_000_000];

/** Extended fade time byte -> µs; 0 when unused/invalid. */
export function extendedFadeUs(x: number): number {
  const unit = EXTENDED_UNIT_US[(x >> 4) & 7] ?? 0;
  return unit * ((x & 15) + 1);
}

/** Effective fade duration in µs: extended fade time wins when set. */
export function fadeDurationUs(fadeTime: number, extendedFadeTime: number): number {
  const ext = extendedFadeUs(extendedFadeTime);
  return ext > 0 ? ext : Math.round(fadeTimeSeconds(fadeTime) * 1e6);
}
