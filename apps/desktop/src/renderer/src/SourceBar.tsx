import { useCallback, useEffect, useState } from 'react';
import type { DeviceList } from '../../shared';

interface IpSettings { role: 'client' | 'server'; host: string; port: number; listenAll?: boolean }
const IP_KEY = 'dali-scout.ip';
function loadIp(): IpSettings {
  try {
    const v = JSON.parse(localStorage.getItem(IP_KEY) ?? 'null') as IpSettings | null;
    if (v && (v.role === 'client' || v.role === 'server') && Number.isInteger(v.port)) return v;
  } catch { /* no storage */ }
  return { role: 'client', host: '', port: 62386 };
}

export function SourceBar({ running }: { running: boolean }) {
  const [list, setList] = useState<DeviceList>({ devices: [], warnings: [] });
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [ip, setIpState] = useState<IpSettings>(loadIp);
  const setIp = (v: IpSettings) => { setIpState(v); try { localStorage.setItem(IP_KEY, JSON.stringify(v)); } catch { /* private mode */ } };

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
      <span className="sep" />
      <select value={ip.role} onChange={(e) => setIp({ ...ip, role: e.target.value as IpSettings['role'] })}
        title="Gateway: connect to a DALI-over-IP gateway. Listen: wait for a controller / gateway driver to send to this PC (answers come from the Simulator).">
        <option value="client">IP gateway</option>
        <option value="server">IP listen</option>
      </select>
      {ip.role === 'client' && (
        <input value={ip.host} placeholder="host or IP" style={{ width: 130 }} onChange={(e) => setIp({ ...ip, host: e.target.value.trim() })} />
      )}
      <input type="number" min={1} max={65535} value={ip.port} style={{ width: 70 }} title="UDP port (DALI-over-IP default 62386)"
        onChange={(e) => setIp({ ...ip, port: Number(e.target.value) })} />
      {ip.role === 'server' && (
        <label className="inline" title="Off: only programs on this PC can send to us. On: any machine on the network can (UDP, no authentication).">
          <input type="checkbox" checked={!!ip.listenAll} onChange={(e) => setIp({ ...ip, listenAll: e.target.checked })} /> network
        </label>
      )}
      <button disabled={(ip.role === 'client' && !ip.host) || !(ip.port >= 1 && ip.port <= 65535)}
        onClick={() => window.dali.connect({ kind: 'ip', ...ip })}>{ip.role === 'client' ? 'Connect IP' : 'Listen'}</button>
      {running && <span className="muted">· source active</span>}
      {list.warnings.map((w, i) => <span key={i} className="warn" title={w}>⚠ {w.slice(0, 70)}</span>)}
    </div>
  );
}
