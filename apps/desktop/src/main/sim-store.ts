import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSimState, type SimStateFile } from '@dali-scout/core';
import type { SavedStateInfo } from '../shared';

/** What the simulator host needs from persistent storage (so tests can use a directory in /tmp). */
export interface SimPersistence {
  /** Remember the state between sessions: save it while running, restore it at start. */
  autoEnabled(): boolean;
  setAuto(on: boolean): void;
  loadAuto(): SimStateFile | undefined;
  saveAuto(f: SimStateFile): void;
  list(): SavedStateInfo[];
  save(name: string, f: SimStateFile): string;
  load(name: string): SimStateFile;
  remove(name: string): void;
}

/** A name that is safe as a file name and stays readable. Returns the cleaned name or throws. */
export function cleanStateName(raw: string): string {
  const n = raw.trim().replace(/[^\p{L}\p{N} _.()+-]/gu, '_').replace(/^\.+/, '').slice(0, 60).trim();
  if (!n) throw new Error('Please enter a name for the state');
  return n;
}

/**
 * Files under `<dir>`: `autosave.json` (the state to restore at start), `settings.json` and
 * `states/<name>.json` (manual saves). Writes are atomic (temp file + rename) so a crash cannot
 * leave a half-written state behind.
 */
export class SimStore implements SimPersistence {
  private readonly statesDir: string;
  constructor(private readonly dir: string) {
    this.statesDir = join(dir, 'states');
  }

  private write(path: string, text: string): void {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  }

  autoEnabled(): boolean {
    try { return JSON.parse(readFileSync(join(this.dir, 'settings.json'), 'utf8')).restoreOnStart !== false; }
    catch { return true; }
  }

  setAuto(on: boolean): void {
    this.write(join(this.dir, 'settings.json'), JSON.stringify({ restoreOnStart: on }));
  }

  /** Undefined when nothing was saved yet; throws when the file is damaged. */
  loadAuto(): SimStateFile | undefined {
    let text: string;
    try { text = readFileSync(join(this.dir, 'autosave.json'), 'utf8'); }
    catch { return undefined; }
    try { return parseSimState(text); }
    catch (e) {
      // keep the damaged file for inspection instead of overwriting it with the next save
      try { renameSync(join(this.dir, 'autosave.json'), join(this.dir, 'autosave.bad.json')); } catch { /* ignore */ }
      throw new Error(`${(e as Error).message} (the file was kept as autosave.bad.json)`);
    }
  }

  saveAuto(f: SimStateFile): void {
    this.write(join(this.dir, 'autosave.json'), JSON.stringify(f));
  }

  list(): SavedStateInfo[] {
    let names: string[];
    try { names = readdirSync(this.statesDir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out: SavedStateInfo[] = [];
    for (const f of names) {
      try {
        const s = JSON.parse(readFileSync(join(this.statesDir, f), 'utf8'));
        out.push({ name: f.slice(0, -5), savedAt: String(s.savedAt ?? ''), gears: Array.isArray(s.gears) ? s.gears.length : 0 });
      } catch { /* skip unreadable files */ }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  save(name: string, f: SimStateFile): string {
    const n = cleanStateName(name);
    this.write(join(this.statesDir, `${n}.json`), JSON.stringify({ ...f, name: n }));
    return n;
  }

  load(name: string): SimStateFile {
    let text: string;
    try { text = readFileSync(join(this.statesDir, `${cleanStateName(name)}.json`), 'utf8'); }
    catch { throw new Error(`No saved state "${name}"`); }
    return parseSimState(text);
  }

  remove(name: string): void {
    rmSync(join(this.statesDir, `${cleanStateName(name)}.json`), { force: true });
  }
}
