import { compileFilter, type Row, type RowFilter } from '@dali-scout/core';

/** A highlight rule colours every row matching its filter; the first enabled matching rule wins. */
export interface HighlightRule { id: number; enabled: boolean; color: string; filter: RowFilter }

const KEY = 'dali-scout.highlights';

export const RULE_COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#ddd6fe'];

// localStorage can be unavailable or hold garbage; rules are a convenience, never a requirement.
export function loadRules(): HighlightRule[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((r) => r && typeof r.id === 'number' && typeof r.color === 'string' && r.filter) : [];
  } catch { return []; }
}

export function saveRules(rules: HighlightRule[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(rules)); } catch { /* ignore */ }
}

export type RowColorizer = (r: Row) => string | undefined;

/** Compile the enabled rules into one function returning the colour of a row, if any. */
export function compileRules(rules: HighlightRule[], t0: number): RowColorizer {
  const active = rules.filter((r) => r.enabled).map((r) => ({ color: r.color, c: compileFilter(r.filter, t0) }))
    .filter((r) => !r.c.error);
  if (active.length === 0) return () => undefined;
  return (row) => active.find((a) => a.c.match(row))?.color;
}
