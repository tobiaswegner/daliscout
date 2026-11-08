import { useCallback, useEffect, useState } from 'react';
import type { DeviceList } from '../../shared';

export function SourceBar({ running }: { running: boolean }) {
  const [list, setList] = useState<DeviceList>({ devices: [], warnings: [] });
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const l = await window.dali.listDevices();
      setList(l);
      setSelected((cur) => (l.devices.some((d) => d.id === cur) ? cur : l.devices[0]?.id ?? ''));
    } finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="sourcebar">
      <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={list.devices.length === 0}
        title={list.devices.find((d) => d.id === selected)?.detail}>
        {list.devices.length === 0 && <option value="">No device found</option>}
        {list.devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      <button onClick={() => window.dali.connect({ kind: 'device', id: selected })} disabled={!selected}>Connect</button>
      <button onClick={refresh} disabled={busy} title="Rescan USB and serial devices">↻</button>
      <button onClick={() => window.dali.connect({ kind: 'virtual' })}>Virtual bus</button>
      {running && <span className="muted">· source active</span>}
      {list.warnings.map((w, i) => <span key={i} className="warn" title={w}>⚠ {w.slice(0, 70)}</span>)}
    </div>
  );
}
