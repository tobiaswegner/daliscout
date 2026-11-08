import { toHex } from './frame.js';
import type { Row } from './session.js';

export interface ExportOptions {
  /** Timestamp (µs) that time columns are relative to. Default: first row. */
  t0?: number;
}

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const answerText = (r: Row): string =>
  !r.decoded.expectsAnswer ? '' : r.answerStatus === 'answered' ? (r.decoded.answer ?? '') : r.answerStatus === 'none' ? 'no answer' : '';

const CSV_HEADER = ['seq', 'time_s', 'delta_ms', 'dir', 'bits', 'hex', 'target', 'command', 'parameters', 'answer', 'summary', 'warnings'];

/** RFC 4180 CSV, CRLF line endings, decoded fields included. */
export function rowsToCsv(rows: readonly Row[], opts: ExportOptions = {}): string {
  const t0 = opts.t0 ?? rows[0]?.frame.ts ?? 0;
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    const d = r.decoded;
    lines.push([
      r.seq, ((r.frame.ts - t0) / 1e6).toFixed(6), (r.deltaUs / 1000).toFixed(3), r.frame.dir,
      r.frame.bits, toHex(r.frame.data), d.target, d.command, d.params.join('; '), answerText(r),
      d.summary, d.warnings.join('; ')
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Human-readable fixed-column text log. */
export function rowsToText(rows: readonly Row[], opts: ExportOptions = {}): string {
  const t0 = opts.t0 ?? rows[0]?.frame.ts ?? 0;
  return rows.map((r) => {
    const d = r.decoded;
    const ans = answerText(r);
    return [
      String(r.seq).padStart(7),
      ((r.frame.ts - t0) / 1e6).toFixed(3).padStart(10),
      r.frame.dir,
      toHex(r.frame.data).padEnd(11),
      d.summary + (d.sendTwice ? ' [x2]' : '') + (ans ? `  => ${ans}` : '') +
        (d.warnings.length ? `  !! ${d.warnings.join('; ')}` : '')
    ].join('  ');
  }).join('\n') + (rows.length ? '\n' : '');
}
