import type { RowFilter } from '@dali-scout/core';

const KEY = 'dali-scout.filter-presets';

// localStorage can be unavailable or hold garbage; presets are a convenience, never a requirement.
export function loadPresets(): Record<string, RowFilter> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export function savePresets(p: Record<string, RowFilter>): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
