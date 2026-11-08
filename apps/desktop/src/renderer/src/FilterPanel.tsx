import { useState } from 'react';
import type { AddrKind, DecodedClass, RowFilter } from '@dali-scout/core';
import { loadPresets, savePresets } from './presets';

const CLASSES: DecodedClass[] = ['arc', 'config', 'query', 'special', 'extended', 'control-device', 'answer', 'error', 'unknown'];
const ADDR_KINDS: AddrKind[] = ['short', 'group', 'broadcast', 'broadcast-unaddressed', 'special'];

const num = (v: string): number | undefined => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

export function FilterPanel({ filter, onChange, error }: {
  filter: RowFilter; onChange: (f: RowFilter) => void; error?: string;
}) {
  const [presets, setPresets] = useState(loadPresets);
  const [name, setName] = useState('');
  const set = (patch: Partial<RowFilter>) => onChange({ ...filter, ...patch });
  const toggleClass = (c: DecodedClass) => {
    const cur = new Set(filter.classes ?? []);
    cur.has(c) ? cur.delete(c) : cur.add(c);
    set({ classes: [...cur] });
  };
  const savePreset = () => {
    const n = name.trim();
    if (!n) return;
    const next = { ...presets, [n]: filter };
    setPresets(next); savePresets(next); setName('');
  };
  const delPreset = (n: string) => {
    const { [n]: _, ...rest } = presets;
    setPresets(rest); savePresets(rest);
  };

  return (
    <section className="panel filters">
      <div className="grid">
        <label>Text
          <input value={filter.text ?? ''} onChange={(e) => set({ text: e.target.value })}
            placeholder={filter.regex ? 'regular expression' : 'all terms must match'} />
        </label>
        <label className="inline"><input type="checkbox" checked={!!filter.regex}
          onChange={(e) => set({ regex: e.target.checked })} /> Regex</label>

        <label>Command
          <input value={filter.command ?? ''} onChange={(e) => set({ command: e.target.value })} placeholder="e.g. SCENE" />
        </label>
        <label>Direction
          <select value={filter.dirs?.[0] ?? ''} onChange={(e) => set({ dirs: e.target.value ? [e.target.value as 'rx' | 'tx'] : undefined })}>
            <option value="">any</option><option value="rx">rx (seen)</option><option value="tx">tx (sent)</option>
          </select>
        </label>
        <label>Address
          <span className="pair">
            <select value={filter.addrKind ?? ''} onChange={(e) => set({ addrKind: (e.target.value || undefined) as AddrKind | undefined, addrValue: undefined })}>
              <option value="">any</option>
              {ADDR_KINDS.map((k) => <option key={k}>{k}</option>)}
            </select>
            <input type="number" min={0} max={63} style={{ width: 64 }} placeholder="n"
              disabled={filter.addrKind !== 'short' && filter.addrKind !== 'group'}
              value={filter.addrValue ?? ''} onChange={(e) => set({ addrValue: num(e.target.value) })} />
          </span>
        </label>
        <label>Query reply
          <select value={filter.answer ?? ''} onChange={(e) => set({ answer: (e.target.value || undefined) as 'answered' | 'none' | undefined })}>
            <option value="">any</option><option value="answered">answered</option><option value="none">no answer</option>
          </select>
        </label>
        <label>Level (0–254)
          <span className="pair">
            <input type="number" min={0} max={254} placeholder="min" value={filter.levelMin ?? ''} onChange={(e) => set({ levelMin: num(e.target.value) })} />
            <input type="number" min={0} max={254} placeholder="max" value={filter.levelMax ?? ''} onChange={(e) => set({ levelMax: num(e.target.value) })} />
          </span>
        </label>
        <label>Time window [s]
          <span className="pair">
            <input type="number" min={0} step="any" placeholder="from" value={filter.fromS ?? ''} onChange={(e) => set({ fromS: num(e.target.value) })} />
            <input type="number" min={0} step="any" placeholder="to" value={filter.toS ?? ''} onChange={(e) => set({ toS: num(e.target.value) })} />
          </span>
        </label>
        <label className="inline"><input type="checkbox" checked={!!filter.errorsOnly} onChange={(e) => set({ errorsOnly: e.target.checked || undefined })} /> Errors only</label>
        <label className="inline"><input type="checkbox" checked={!!filter.unknownOnly} onChange={(e) => set({ unknownOnly: e.target.checked || undefined })} /> Unknown only</label>
      </div>

      <div className="chips">
        {CLASSES.map((c) => (
          <label key={c} className={`chip k-${c} ${filter.classes?.includes(c) ? 'on' : ''}`}>
            <input type="checkbox" checked={!!filter.classes?.includes(c)} onChange={() => toggleClass(c)} />{c}
          </label>
        ))}
      </div>

      {error && <div className="warn">⚠ Invalid regular expression: {error}</div>}

      <div className="presets">
        <button onClick={() => onChange({})}>Clear filter</button>
        <span className="sep" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="preset name" />
        <button onClick={savePreset} disabled={!name.trim()}>Save preset</button>
        {Object.keys(presets).map((n) => (
          <span key={n} className="preset">
            <button onClick={() => onChange(presets[n]!)}>{n}</button>
            <button className="x" title="Delete preset" onClick={() => delPreset(n)}>×</button>
          </span>
        ))}
      </div>
    </section>
  );
}
