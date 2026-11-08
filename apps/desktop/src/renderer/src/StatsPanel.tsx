import type { StatsSnapshot } from '@dali-scout/core';

export function StatsPanel({ stats }: { stats: StatsSnapshot }) {
  const pct = (stats.busLoad * 100).toFixed(1);
  return (
    <section className="panel stats">
      <div className="cards">
        <Card label="Telegrams" value={stats.total} />
        <Card label="Forward" value={stats.forward} />
        <Card label="Backward" value={stats.backward} />
        <Card label="Errors" value={stats.errors} warn={stats.errors > 0} />
        <Card label="Unknown" value={stats.unknown} warn={stats.unknown > 0} />
        <Card label="Unanswered queries" value={stats.unanswered} />
        <Card label="Frames/s (1 s)" value={stats.framesPerSecond.toFixed(1)} />
      </div>
      <div className="load">
        <span>Bus load (1 s window): {pct} %</span>
        <div className="bar"><div style={{ width: `${Math.min(100, stats.busLoad * 100)}%` }} /></div>
      </div>
      <div className="addrs">
        <strong>Most active targets</strong>
        {stats.perAddress.length === 0 && <span className="muted"> — none yet</span>}
        <ul>
          {stats.perAddress.slice(0, 8).map((a) => <li key={a.label}><span>{a.label}</span><span>{a.count}</span></li>)}
        </ul>
      </div>
    </section>
  );
}

function Card({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return <div className={`card ${warn ? 'warn' : ''}`}><div className="v">{value}</div><div className="l">{label}</div></div>;
}
