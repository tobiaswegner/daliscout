import type { FrameDir } from './frame.js';
import { toHex } from './frame.js';
import type { AddrKind, DecodedClass } from './decoder.js';
import type { Row } from './session.js';

/** Structured + free-text row filter. Every set field must match (AND). */
export interface RowFilter {
  /** Free text. Plain mode: whitespace-separated terms, all must occur. */
  text?: string;
  /** Treat `text` as one case-insensitive regular expression. */
  regex?: boolean;
  dirs?: FrameDir[];
  classes?: DecodedClass[];
  addrKind?: AddrKind;
  /** Only meaningful with addrKind short/group. */
  addrValue?: number;
  /** Substring of the decoded command name (case-insensitive). */
  command?: string;
  /** Queries that were answered / not answered. */
  answer?: 'answered' | 'none';
  errorsOnly?: boolean;
  unknownOnly?: boolean;
  /** Raw arc level range 0..254; rows without a level never match. */
  levelMin?: number;
  levelMax?: number;
  /** Time window in seconds, relative to the first frame of the capture. */
  fromS?: number;
  toS?: number;
}

export function isEmptyFilter(f: RowFilter): boolean {
  return Object.values(f).every((v) => v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || v === false);
}

/** Text every free-text search runs against. */
export function rowHaystack(r: Row): string {
  const d = r.decoded;
  return [r.seq, r.frame.dir, toHex(r.frame.data), d.target, d.command, d.params.join(' '),
    d.answer ?? '', d.summary, d.warnings.join(' ')].join(' ').toLowerCase();
}

export interface CompiledFilter {
  match: (r: Row) => boolean;
  /** Set when the filter is invalid (e.g. a broken regex); `match` then matches nothing. */
  error?: string;
}

/** @param t0 timestamp (µs) of the first frame; time windows are relative to it. */
export function compileFilter(f: RowFilter, t0: number): CompiledFilter {
  const preds: ((r: Row) => boolean)[] = [];
  const text = f.text?.trim();
  if (text) {
    if (f.regex) {
      let re: RegExp;
      try { re = new RegExp(text, 'i'); }
      catch (e) { return { match: () => false, error: (e as Error).message }; }
      preds.push((r) => re.test(rowHaystack(r)));
    } else {
      const terms = text.toLowerCase().split(/\s+/);
      preds.push((r) => { const h = rowHaystack(r); return terms.every((t) => h.includes(t)); });
    }
  }
  if (f.dirs?.length) { const s = new Set(f.dirs); preds.push((r) => s.has(r.frame.dir)); }
  if (f.classes?.length) { const s = new Set(f.classes); preds.push((r) => s.has(r.decoded.class)); }
  if (f.addrKind) {
    const { addrKind: k, addrValue: v } = f;
    preds.push((r) => r.decoded.addr?.kind === k && (v === undefined || r.decoded.addr.value === v));
  }
  if (f.command?.trim()) {
    const c = f.command.trim().toLowerCase();
    preds.push((r) => r.decoded.command.toLowerCase().includes(c));
  }
  if (f.answer) {
    const want = f.answer;
    preds.push((r) => r.decoded.expectsAnswer && r.answerStatus === want);
  }
  if (f.errorsOnly) preds.push((r) => r.decoded.class === 'error' || r.frame.kind === 'error');
  if (f.unknownOnly) preds.push((r) => r.decoded.unknown);
  if (f.levelMin !== undefined || f.levelMax !== undefined) {
    const lo = f.levelMin ?? 0, hi = f.levelMax ?? 254;
    preds.push((r) => r.decoded.level !== undefined && r.decoded.level >= lo && r.decoded.level <= hi);
  }
  if (f.fromS !== undefined || f.toS !== undefined) {
    const lo = (f.fromS ?? -Infinity) * 1e6, hi = (f.toS ?? Infinity) * 1e6;
    preds.push((r) => { const t = r.frame.ts - t0; return t >= lo && t <= hi; });
  }
  return { match: preds.length === 0 ? () => true : (r) => preds.every((p) => p(r)) };
}
