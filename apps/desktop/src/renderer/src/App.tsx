import { useEffect, useRef, useState } from 'react';
import { toHex, type Row } from '@dali-scout/core';
import { useMonitor } from './useMonitor';
import { FilterPanel } from './FilterPanel';
import { SendPanel } from './SendPanel';
import { SourceBar } from './SourceBar';
import { StatsPanel } from './StatsPanel';
import { exportRows, type ExportFormat } from './exporters';

const ROW_H = 22;
const OVERSCAN = 20;
type Panel = 'filter' | 'send' | 'stats' | null;

export function App() {
  const m = useMonitor();
  const [follow, setFollow] = useState(true);
  const [panel, setPanel] = useState<Panel>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [filteredExport, setFilteredExport] = useState(true);
  const [notice, setNotice] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [m.version, follow]);

  const onScroll = () => {
    const el = scroller.current!;
    setView({ top: el.scrollTop, height: el.clientHeight });
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H;
    if (!atBottom && follow) setFollow(false);
  };

  const doExport = async (format: ExportFormat) => {
    try {
      const rows = m.exportRows(filteredExport);
      const msg = await exportRows(rows, format, m.firstTs);
      if (msg) setNotice(msg);
    } catch (e) {
      setNotice(`Export failed: ${(e as Error).message}`);
    }
  };

  const toggle = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p));

  const start = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN);
  const end = Math.min(m.count, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN);
  const rows: { r: Row; i: number }[] = [];
  for (let i = start; i < end; i++) { const r = m.rowAt(i); if (r) rows.push({ r, i }); }
  const selected = selectedSeq !== null ? m.bySeq(selectedSeq) : undefined;
  const running = m.source.state === 'running';

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">DALI Scout</strong>
        <SourceBar running={running} />
        <span className="sep" />
        <button onClick={() => window.dali.openCapture()}>Open capture…</button>
        <button onClick={() => window.dali.startDemo()}>Demo</button>
        <button onClick={() => window.dali.stop()} disabled={!running}>Stop</button>
        {m.source.kind === 'replay' && (
          <label>
            Speed{' '}
            <select value={speed} onChange={(e) => { const v = Number(e.target.value); setSpeed(v); window.dali.setReplaySpeed(v); }}>
              {[0.5, 1, 2, 5, 10, 100].map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
          </label>
        )}
      </header>

      <div className="toolbar second">
        <button className={panel === 'filter' ? 'on' : ''} onClick={() => toggle('filter')}>
          Filter{m.filterActive ? ' ●' : ''}
        </button>
        <button className={panel === 'send' ? 'on' : ''} onClick={() => toggle('send')}>Send</button>
        <button className={panel === 'stats' ? 'on' : ''} onClick={() => toggle('stats')}>Statistics</button>
        <span className="sep" />
        <button onClick={m.togglePause}>{m.paused ? `Resume (${m.heldCount})` : 'Pause'}</button>
        <button onClick={m.clear}>Clear</button>
        <label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow</label>
        <span className="grow" />
        <label title="Export only the rows that match the current filter">
          <input type="checkbox" checked={filteredExport} disabled={!m.filterActive}
            onChange={(e) => setFilteredExport(e.target.checked)} /> filtered rows only
        </label>
        <span>Export:</span>
        <button onClick={() => doExport('csv')} disabled={m.total === 0}>CSV</button>
        <button onClick={() => doExport('txt')} disabled={m.total === 0}>Text</button>
        <button onClick={() => doExport('dscap')} disabled={m.total === 0}>.dscap</button>
      </div>

      {panel === 'filter' && <FilterPanel filter={m.filter} onChange={m.setFilter} error={m.filterError} />}
      {panel === 'send' && <SendPanel canSend={!!m.source.canSend && running} />}
      {panel === 'stats' && <StatsPanel stats={m.stats()} />}

      <div className="thead row">
        <span className="c-seq">#</span><span className="c-time">Time [s]</span><span className="c-delta">Δ [ms]</span>
        <span className="c-dir">Dir</span><span className="c-hex">Raw</span><span className="c-target">Target</span>
        <span className="c-cmd">Command</span><span className="c-params">Parameters</span><span className="c-answer">Answer</span>
      </div>

      <div className="table" ref={scroller} onScroll={onScroll}>
        <div style={{ height: m.count * ROW_H, position: 'relative' }}>
          {rows.map(({ r, i }) => (
            <TelegramRow key={r.seq} r={r} top={i * ROW_H} t0={m.firstTs}
              selected={r.seq === selectedSeq} onSelect={() => setSelectedSeq(r.seq)} />
          ))}
        </div>
      </div>

      {selected && <Detail r={selected} bySeq={m.bySeq} onJump={setSelectedSeq} />}

      <footer className="status">
        <span className={`dot ${m.source.state}`} />
        {m.source.state === 'idle' && 'No source — connect a device, open a capture or start the demo'}
        {m.source.state === 'running' && `Active: ${m.source.label}${m.source.canSend ? '' : ' (receive only)'}`}
        {m.source.state === 'finished' && `Finished: ${m.source.label}`}
        {m.source.state === 'error' && `Error: ${m.source.error ?? 'unknown'}`}
        {notice && <span className="notice">· {notice}</span>}
        <span className="grow" />
        {m.filterActive ? `${m.count} of ${m.total} telegrams` : `${m.total} telegrams`}
        {m.paused && ' · paused'}
      </footer>
    </div>
  );
}

function TelegramRow({ r, top, t0, selected, onSelect }: {
  r: Row; top: number; t0: number; selected: boolean; onSelect: () => void;
}) {
  const d = r.decoded;
  const cls = ['row', 'body', `k-${d.class}`, r.frame.dir === 'tx' ? 'tx' : '', selected ? 'selected' : '',
    d.unknown ? 'unknown' : ''].join(' ');
  const answer = d.expectsAnswer
    ? (r.answerStatus === 'answered' ? d.answer : r.answerStatus === 'none' ? 'no answer' : '…')
    : '';
  return (
    <div className={cls} style={{ top, height: ROW_H }} onClick={onSelect}>
      <span className="c-seq">{r.seq}</span>
      <span className="c-time">{((r.frame.ts - t0) / 1e6).toFixed(3)}</span>
      <span className="c-delta">{(r.deltaUs / 1000).toFixed(1)}</span>
      <span className="c-dir">{r.frame.dir}</span>
      <span className="c-hex mono">{toHex(r.frame.data)}<small> {r.frame.bits}b</small></span>
      <span className="c-target">{d.target}</span>
      <span className="c-cmd">{d.class === 'answer' ? d.summary : d.command}{d.sendTwice ? ' ×2' : ''}</span>
      <span className="c-params">{d.params.join(', ')}</span>
      <span className={`c-answer ${r.answerStatus}`}>{answer}</span>
    </div>
  );
}

function Detail({ r, bySeq, onJump }: { r: Row; bySeq: (s: number) => Row | undefined; onJump: (s: number) => void }) {
  const d = r.decoded;
  const link = r.answerSeq !== undefined ? bySeq(r.answerSeq) : d.answerTo !== undefined ? bySeq(d.answerTo) : undefined;
  return (
    <aside className="detail">
      <div><strong>{d.summary}</strong></div>
      <div className="mono">#{r.seq} · {r.frame.dir} · {r.frame.bits} bit · {toHex(r.frame.data)} · layer {d.layer} · source {r.frame.source}</div>
      {d.warnings.map((w, i) => <div key={i} className="warn">⚠ {w}</div>)}
      {link && <div>{d.answerTo !== undefined ? 'Answers' : 'Answered by'}{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); onJump(link.seq); }}>#{link.seq}</a></div>}
    </aside>
  );
}
