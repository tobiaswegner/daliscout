import { rowsToCsv, rowsToText, serializeCapture, type Row } from '@dali-scout/core';

export type ExportFormat = 'csv' | 'txt' | 'dscap';

export async function exportRows(rows: Row[], format: ExportFormat, t0: number): Promise<string> {
  const base = `dali-capture-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  const spec = {
    csv: { ext: 'csv', name: 'CSV', content: () => rowsToCsv(rows, { t0 }) },
    txt: { ext: 'txt', name: 'Text log', content: () => rowsToText(rows, { t0 }) },
    dscap: { ext: 'dscap', name: 'DALI Scout capture', content: () => serializeCapture(rows.map((r) => r.frame)) }
  }[format];
  const res = await window.dali.saveFile({
    defaultName: `${base}.${spec.ext}`, filters: [{ name: spec.name, extensions: [spec.ext] }], content: spec.content()
  });
  return res.saved ? `Saved ${rows.length} telegrams to ${res.path}` : '';
}
