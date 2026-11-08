import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CaptureSession, StatsTracker, compileFilter, isEmptyFilter,
  type BusFrame, type CompiledFilter, type Row, type RowFilter
} from '@dali-scout/core';
import type { SourceInfo } from '../../shared';

/** Owns the capture session, feeds it from IPC, and maintains the filtered view. */
export function useMonitor() {
  const session = useRef(new CaptureSession());
  const stats = useRef(new StatsTracker());
  const t0 = useRef<number | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [source, setSource] = useState<SourceInfo>({ state: 'idle', label: '' });
  const [filter, setFilterState] = useState<RowFilter>({});
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const held = useRef<BusFrame[]>([]);
  const matches = useRef<number[]>([]); // seqs of rows matching the current filter
  const filterRef = useRef(filter);
  const compiled = useRef<CompiledFilter>({ match: () => true });
  const active = !isEmptyFilter(filter);
  const activeRef = useRef(active);
  activeRef.current = active;

  const recompile = useCallback(() => {
    compiled.current = compileFilter(filterRef.current, t0.current ?? 0);
  }, []);

  const ingest = useCallback((frames: BusFrame[]) => {
    for (const f of frames) {
      if (t0.current === undefined) { t0.current = f.ts; recompile(); }
      const row = session.current.push(f);
      stats.current.add(row);
      if (activeRef.current && compiled.current.match(row)) matches.current.push(row.seq);
    }
    setVersion((v) => v + 1);
  }, [recompile]);

  useEffect(() => {
    const offF = window.dali.onFrames((frames) => {
      if (pausedRef.current) held.current.push(...frames);
      else ingest(frames);
    });
    const offS = window.dali.onSource(setSource);
    return () => { offF(); offS(); };
  }, [ingest]);

  // Re-filter from scratch whenever the filter changes.
  useEffect(() => {
    filterRef.current = filter;
    recompile();
    matches.current = isEmptyFilter(filter)
      ? []
      : session.current.all().filter((r) => compiled.current.match(r)).map((r) => r.seq);
    setVersion((v) => v + 1);
  }, [filter, recompile]);

  const togglePause = useCallback(() => {
    setPaused((p) => {
      if (p && held.current.length) { ingest(held.current); held.current = []; }
      return !p;
    });
  }, [ingest]);

  const clear = useCallback(() => {
    session.current.clear();
    stats.current.reset();
    t0.current = undefined;
    matches.current = [];
    held.current = [];
    setVersion((v) => v + 1);
  }, []);

  const s = session.current;
  const count = active ? matches.current.length : s.length;
  const rowAt = (i: number): Row | undefined => (active ? s.bySeq(matches.current[i] ?? -1) : s.at(i));

  /** Rows to export: the filtered view or the whole capture. */
  const exportRows = (filteredOnly: boolean): Row[] =>
    filteredOnly && active
      ? matches.current.map((q) => s.bySeq(q)).filter((r): r is Row => !!r)
      : [...s.all()];

  return {
    version, count, total: s.length, rowAt, bySeq: (q: number) => s.bySeq(q),
    firstTs: t0.current ?? 0,
    source, filter, setFilter: setFilterState, filterActive: active, filterError: compiled.current.error,
    paused, togglePause, heldCount: held.current.length, clear,
    recent: (n: number): Row[] => s.all().slice(-n),
    stats: () => stats.current.snapshot(s.unanswered),
    exportRows
  };
}
