import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaptureSession, toHex, type BusFrame, type Row } from '@dali-scout/core';
import type { SourceInfo } from '../../shared';

function haystack(r: Row): string {
  const d = r.decoded;
  return [r.seq, r.frame.dir, toHex(r.frame.data), d.target, d.command, d.params.join(' '),
    d.answer ?? '', d.summary, d.warnings.join(' ')].join(' ').toLowerCase();
}

/** Owns the capture session, feeds it from IPC, and maintains the filtered view. */
export function useMonitor() {
  const session = useRef(new CaptureSession());
  const [version, setVersion] = useState(0);
  const [source, setSource] = useState<SourceInfo>({ state: 'idle', label: '' });
  const [query, setQuery] = useState('');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const held = useRef<BusFrame[]>([]);
  const terms = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const termsRef = useRef(terms);
  termsRef.current = terms;
  const matches = useRef<number[]>([]); // seqs of rows matching the current filter

  const matchRow = (r: Row, t: string[]) => {
    if (t.length === 0) return true;
    const h = haystack(r);
    return t.every((x) => h.includes(x));
  };

  const ingest = useCallback((frames: BusFrame[]) => {
    const t = termsRef.current;
    for (const f of frames) {
      const row = session.current.push(f);
      if (t.length && matchRow(row, t)) matches.current.push(row.seq);
    }
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    const offF = window.dali.onFrames((frames) => {
      if (pausedRef.current) held.current.push(...frames);
      else ingest(frames);
    });
    const offS = window.dali.onSource(setSource);
    return () => { offF(); offS(); };
  }, [ingest]);

  // Re-filter from scratch whenever the filter text changes.
  useEffect(() => {
    matches.current = terms.length
      ? session.current.all().filter((r) => matchRow(r, terms)).map((r) => r.seq)
      : [];
    setVersion((v) => v + 1);
  }, [terms]);

  const togglePause = useCallback(() => {
    setPaused((p) => {
      if (p && held.current.length) { ingest(held.current); held.current = []; }
      return !p;
    });
  }, [ingest]);

  const clear = useCallback(() => {
    session.current.clear();
    matches.current = [];
    held.current = [];
    setVersion((v) => v + 1);
  }, []);

  const s = session.current;
  const filtered = terms.length > 0;
  const count = filtered ? matches.current.length : s.length;
  const rowAt = (i: number): Row | undefined =>
    filtered ? s.bySeq(matches.current[i] ?? -1) : s.at(i);

  return {
    version, count, total: s.length, rowAt, bySeq: (q: number) => s.bySeq(q),
    firstTs: s.at(0)?.frame.ts ?? 0,
    source, query, setQuery, paused, togglePause, heldCount: held.current.length, clear
  };
}
