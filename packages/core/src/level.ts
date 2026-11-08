/** DALI arc power level helpers (IEC 62386-102 logarithmic curve). */
export const MASK = 0xff;

/** Level 1..254 -> percent 0.1..100. Level 0 -> 0 (off). MASK is not a level. */
export function levelToPercent(level: number): number {
  if (level <= 0) return 0;
  if (level >= 254) return 100;
  return Math.pow(10, ((level - 1) / 253) * 3 - 1);
}

/** Percent 0.1..100 -> nearest level 1..254. 0 -> 0. */
export function percentToLevel(percent: number): number {
  if (percent <= 0) return 0;
  if (percent >= 100) return 254;
  const lvl = Math.round(((Math.log10(percent) + 1) / 3) * 253 + 1);
  return Math.min(254, Math.max(1, lvl));
}

export function formatLevel(level: number): string {
  if (level === MASK) return 'MASK';
  if (level === 0) return '0 (OFF)';
  const p = levelToPercent(level);
  return `${level} (${p < 10 ? p.toFixed(2) : p.toFixed(1)} %)`;
}
