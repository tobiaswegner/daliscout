import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { compileFilter, findRowIndex, toHex, type Row } from '@dali-scout/core';
import { useMonitor } from './useMonitor';
import { FilterPanel } from './FilterPanel';
import { SendPanel } from './SendPanel';
import { SourceBar } from './SourceBar';
import { StatsPanel } from './StatsPanel';
import { exportRows, type ExportFormat } from './exporters';
import { Simulator } from './Simulator';
import { useSim } from './useSim';
import { BookmarkPanel, HighlightPanel } from './AnnotationPanels';
import { compileRules, loadRules, saveRules, type HighlightRule } from './annotations';

const ROW_H = 22;
const OVERSCAN = 20;
type Panel = 'filter' | 'highlight' | 'bookmarks' | 'send' | 'stats' | null;
type View = 'monitor' | 'simulator';

export function App() {
  const m = useMonitor();
  const { state: simState, run: runSim } = useSim();
  const [tab, setTab] = useState<View>('monitor');
  const [follow, setFollow] = useState(true);
  const [panel, setPanel] = useState<Panel>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [filteredExport, setFilteredExport] = useState(true);
  const [notice, setNotice] = useState('');
  const [rules, setRulesState] = useState<HighlightRule[]>(loadRules);
  const [marks, setMarks] = useState<Map<number, string>>(new Map());
  const [findText, setFindText] = useState('');
  const [findRegex, setFindRegex] = useState(false);
  const findInput = useRef<HTMLInputElement>(null);
  const setRules = (r: HighlightRule[]) => { setRulesState(r); saveRules(r); };
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

  const finder = useMemo(
    () => compileFilter({ text: findText, regex: findRegex }, m.firstTs),
    [findText, findRegex, m.firstTs]);
  const colorOf = useMemo(() => compileRules(rules, m.firstTs), [rules, m.firstTs]);

  /** Select the row at view index `i` and scroll it into the middle of the table. */
  const goTo = useCallback((i: number) => {
    const r = m.rowAt(i);
    if (!r) return;
    setSelectedSeq(r.seq);
    setFollow(false);
    const el = scroller.current;
    if (el) el.scrollTop = Math.max(0, i * ROW_H - el.clientHeight / 2);
  }, [m]);

  const currentIndex = () => {
    if (selectedSeq === null) return -1;
    for (let i = 0; i < m.count; i++) if (m.rowAt(i)?.seq === selectedSeq) return i;
    return -1;
  };
  const findStep = (dir: 1 | -1, match: (r: Row) => boolean): boolean => {
    const i = findRowIndex(m.count, m.rowAt, currentIndex(), dir, match);
    if (i >= 0) goTo(i);
    return i >= 0;
  };
  const find = (dir: 1 | -1) => {
    if (!findText.trim() || finder.error) return;
    if (!findStep(dir, finder.match)) setNotice(`Nothing found for "${findText}"`);
    else setNotice('');
  };
  const nextMark = (dir: 1 | -1) => { if (!findStep(dir, (r) => marks.has(r.seq))) setNotice('No bookmarks in the current view'); };
  const toggleMark = (seq: number) => setMarks((cur) => {
    const n = new Map(cur);
    n.has(seq) ? n.delete(seq) : n.set(seq, '');
    return n;
  });

  // Keyboard: Ctrl+F focus find, F3 / Shift+F3 find next / previous, Ctrl+B bookmark the selected row.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); findInput.current?.focus(); findInput.current?.select(); }
    else if (e.key === 'F3') { e.preventDefault(); find(e.shiftKey ? -1 : 1); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && selectedSeq !== null) { e.preventDefault(); toggleMark(selectedSeq); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

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
        <span className="tabs">
          <button className={tab === 'monitor' ? 'on' : ''} onClick={() => setTab('monitor')}>Monitor</button>
          <button className={tab === 'simulator' ? 'on' : ''} onClick={() => setTab('simulator')}>Simulator</button>
        </span>
        <span className="sep" />
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

      <div className="pane" style={{ display: tab === 'monitor' ? 'flex' : 'none' }}>
        <div className="toolbar second">
          <button className={panel === 'filter' ? 'on' : ''} onClick={() => toggle('filter')}>
            Filter{m.filterActive ? ' ●' : ''}
          </button>
          <button className={panel === 'highlight' ? 'on' : ''} onClick={() => toggle('highlight')}>
            Highlight{rules.some((r) => r.enabled) ? ' ●' : ''}
          </button>
          <button className={panel === 'bookmarks' ? 'on' : ''} onClick={() => toggle('bookmarks')}>
            Bookmarks{marks.size ? ` (${marks.size})` : ''}
          </button>
          <button className={panel === 'send' ? 'on' : ''} onClick={() => toggle('send')}>Send</button>
          <button className={panel === 'stats' ? 'on' : ''} onClick={() => toggle('stats')}>Statistics</button>
          <span className="sep" />
          <button onClick={m.togglePause}>{m.paused ? `Resume (${m.heldCount})` : 'Pause'}</button>
          <button onClick={() => { m.clear(); setMarks(new Map()); setSelectedSeq(null); }}>Clear</button>
          <label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow</label>
          <span className="sep" />
          <span className="find">
            <input ref={findInput} value={findText} placeholder="Find (Ctrl+F)" className={finder.error ? 'bad' : ''}
              onChange={(e) => setFindText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey ? -1 : 1); } }} />
            <button title="Previous match (Shift+F3)" onClick={() => find(-1)} disabled={!findText.trim()}>↑</button>
            <button title="Next match (F3)" onClick={() => find(1)} disabled={!findText.trim()}>↓</button>
            <label title="Regular expression"><input type="checkbox" checked={findRegex} onChange={(e) => setFindRegex(e.target.checked)} /> Regex</label>
          </span>
          <button title="Previous bookmark" onClick={() => nextMark(-1)} disabled={marks.size === 0}>◀ ★</button>
          <button title="Next bookmark" onClick={() => nextMark(1)} disabled={marks.size === 0}>★ ▶</button>
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
        {panel === 'highlight' && <HighlightPanel rules={rules} onChange={setRules} />}
        {panel === 'bookmarks' && (
          <BookmarkPanel marks={marks} bySeq={m.bySeq} onJump={(seq) => {
            for (let i = 0; i < m.count; i++) if (m.rowAt(i)?.seq === seq) { goTo(i); return; }
            setNotice('Bookmarked row is hidden by the current filter');
          }}
            onNote={(s, note) => setMarks((cur) => new Map(cur).set(s, note))}
            onRemove={(s) => toggleMark(s)} onClearAll={() => setMarks(new Map())} />
        )}
        {panel === 'send' && <SendPanel canSend={!!m.source.canSend && running} />}
        {panel === 'stats' && <StatsPanel stats={m.stats()} />}

        <div className="thead row">
          <span className="c-mark" /><span className="c-seq">#</span><span className="c-time">Time [s]</span><span className="c-delta">Δ [ms]</span>
          <span className="c-dir">Dir</span><span className="c-hex">Raw</span><span className="c-target">Target</span>
          <span className="c-cmd">Command</span><span className="c-params">Parameters</span><span className="c-answer">Answer</span>
        </div>

        <div className="table" ref={scroller} onScroll={onScroll}>
          <div style={{ height: m.count * ROW_H, position: 'relative' }}>
            {rows.map(({ r, i }) => (
              <TelegramRow key={r.seq} r={r} top={i * ROW_H} t0={m.firstTs}
                selected={r.seq === selectedSeq} color={colorOf(r)} marked={marks.has(r.seq)}
                onMark={() => toggleMark(r.seq)} onSelect={() => setSelectedSeq(r.seq)} />
            ))}
          </div>
        </div>

        {selected && <Detail r={selected} bySeq={m.bySeq} onJump={setSelectedSeq} />}

      </div>

      {tab === 'simulator' && (
        <Simulator sim={simState} run={runSim} active={running && simState.active}
          canSend={!!m.source.canSend && running} total={m.total} rowAt={m.allAt} version={m.version} />
      )}

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

function TelegramRow({ r, top, t0, selected, color, marked, onMark, onSelect }: {
  r: Row; top: number; t0: number; selected: boolean; color?: string; marked: boolean;
  onMark: () => void; onSelect: () => void;
}) {
  const d = r.decoded;
  const cls = ['row', 'body', `k-${d.class}`, r.frame.dir === 'tx' ? 'tx' : '', selected ? 'selected' : '',
    d.unknown ? 'unknown' : ''].join(' ');
  const answer = d.expectsAnswer
    ? (r.answerStatus === 'answered' ? d.answer : r.answerStatus === 'none' ? 'no answer' : '…')
    : '';
  return (
    <div className={cls} style={{ top, height: ROW_H, ...(color && !selected ? { background: color, color: '#111' } : {}) }} onClick={onSelect}>
      <span className={`c-mark ${marked ? 'on' : ''}`} title="Bookmark (Ctrl+B)"
        onClick={(e) => { e.stopPropagation(); onMark(); }}>{marked ? '★' : '☆'}</span>
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
