import type { Row, RowFilter } from '@dali-scout/core';
import { toHex } from '@dali-scout/core';
import { RULE_COLORS, type HighlightRule } from './annotations';

export function HighlightPanel({ rules, onChange }: { rules: HighlightRule[]; onChange: (r: HighlightRule[]) => void }) {
  const update = (id: number, patch: Partial<HighlightRule>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const updateFilter = (id: number, patch: Partial<RowFilter>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, filter: { ...r.filter, ...patch } } : r)));
  const add = () => onChange([...rules, {
    id: Math.max(0, ...rules.map((r) => r.id)) + 1, enabled: true,
    color: RULE_COLORS[rules.length % RULE_COLORS.length]!, filter: { text: '' }
  }]);
  return (
    <section className="panel highlights">
      <div className="muted">Rows matching a rule are coloured; the first matching rule wins.</div>
      {rules.map((r) => (
        <div key={r.id} className="rule">
          <input type="checkbox" checked={r.enabled} title="Enabled" onChange={(e) => update(r.id, { enabled: e.target.checked })} />
          <input type="color" value={r.color} title="Colour" onChange={(e) => update(r.id, { color: e.target.value })} />
          <input value={r.filter.text ?? ''} placeholder="text" onChange={(e) => updateFilter(r.id, { text: e.target.value })} />
          <label className="inline"><input type="checkbox" checked={!!r.filter.regex}
            onChange={(e) => updateFilter(r.id, { regex: e.target.checked })} /> Regex</label>
          <input value={r.filter.command ?? ''} placeholder="command contains" onChange={(e) => updateFilter(r.id, { command: e.target.value })} />
          <select value={r.filter.answer ?? ''} onChange={(e) => updateFilter(r.id, { answer: (e.target.value || undefined) as 'answered' | 'none' | undefined })}>
            <option value="">any reply</option><option value="answered">answered</option><option value="none">no answer</option>
          </select>
          <label className="inline"><input type="checkbox" checked={!!r.filter.errorsOnly}
            onChange={(e) => updateFilter(r.id, { errorsOnly: e.target.checked || undefined })} /> Errors</label>
          <button className="x" title="Delete rule" onClick={() => onChange(rules.filter((x) => x.id !== r.id))}>×</button>
        </div>
      ))}
      <div><button onClick={add}>Add rule</button></div>
    </section>
  );
}

export function BookmarkPanel({ marks, bySeq, onJump, onNote, onRemove, onClearAll }: {
  marks: Map<number, string>; bySeq: (s: number) => Row | undefined;
  onJump: (seq: number) => void; onNote: (seq: number, note: string) => void;
  onRemove: (seq: number) => void; onClearAll: () => void;
}) {
  const seqs = [...marks.keys()].sort((a, b) => a - b);
  return (
    <section className="panel bookmarks">
      {seqs.length === 0 && <div className="muted">No bookmarks. Click the ☆ in a row (or press Ctrl+B) to add one.</div>}
      {seqs.map((s) => {
        const r = bySeq(s);
        return (
          <div key={s} className="rule">
            <a href="#" onClick={(e) => { e.preventDefault(); onJump(s); }}>#{s}</a>
            <span className="mono">{r ? toHex(r.frame.data) : ''}</span>
            <span>{r?.decoded.summary ?? '(row no longer available)'}</span>
            <input className="grow" value={marks.get(s) ?? ''} placeholder="note" onChange={(e) => onNote(s, e.target.value)} />
            <button className="x" title="Remove bookmark" onClick={() => onRemove(s)}>×</button>
          </div>
        );
      })}
      {seqs.length > 0 && <div><button onClick={onClearAll}>Remove all</button></div>}
    </section>
  );
}
