import { useState } from 'react';
import type { SimCommand, SimCommandResult, SimState } from '../../shared';

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
};

/** Save / restore of the simulated gears: automatic between sessions, named states for testing, files. */
export function StateBar({ persist, busy, exec, report }: {
  persist: NonNullable<SimState['persist']>; busy: boolean;
  exec: (c: SimCommand) => Promise<void>; report: (r: SimCommandResult) => void;
}) {
  const [name, setName] = useState('');
  const [pick, setPick] = useState('');
  const chosen = persist.saved.some((s) => s.name === pick) ? pick : persist.saved[0]?.name ?? '';

  return (
    <div className="toolbar second statebar">
      <strong>State</strong>
      <label className="inline" title="Save the gears while running and restore them when the simulator starts">
        <input type="checkbox" checked={persist.auto} onChange={(e) => exec({ type: 'autoState', value: e.target.checked })} />
        Remember between sessions
      </label>
      <span className="sep" />
      <input value={name} placeholder="name" style={{ width: 130 }} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { void exec({ type: 'saveState', name }); setPick(name.trim()); } }} />
      <button disabled={busy || !name.trim()} title="Keep the current gears under this name"
        onClick={() => { void exec({ type: 'saveState', name }); setPick(name.trim()); }}>Save state</button>
      <select value={chosen} disabled={persist.saved.length === 0} onChange={(e) => setPick(e.target.value)}>
        {persist.saved.length === 0 && <option value="">no saved states</option>}
        {persist.saved.map((s) => <option key={s.name} value={s.name}>{s.name} — {s.gears} gears, {when(s.savedAt)}</option>)}
      </select>
      <button disabled={busy || !chosen} title="Replace the gears with this state"
        onClick={() => exec({ type: 'restoreState', name: chosen })}>Restore</button>
      <button disabled={!chosen} onClick={() => { if (confirm(`Delete the saved state "${chosen}"?`)) void exec({ type: 'deleteState', name: chosen }); }}>Delete</button>
      <span className="sep" />
      <button onClick={async () => report(await window.dali.exportSimState())}>Save to file…</button>
      <button disabled={busy} onClick={async () => report(await window.dali.importSimState())}>Load file…</button>
      {persist.restored && <span className="ok">✓ {persist.restored}</span>}
      {persist.error && <span className="warn">⚠ {persist.error}</span>}
    </div>
  );
}
