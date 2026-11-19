import { createGearState } from './gear.js';
import type { GearState } from './types.js';

/** Identifies a saved simulator state, on disk and in exported files. */
export const SIM_STATE_FORMAT = 'dali-scout-sim';
export const SIM_STATE_VERSION = 1;

/**
 * A saved simulator state: every gear's complete register set. Times inside the gears (fades, timers)
 * are absolute simulation times; `simNowUs` says what the clock read when the state was taken, so they
 * can be rebased onto the clock of whoever loads the state.
 */
export interface SimStateFile {
  format: typeof SIM_STATE_FORMAT;
  version: typeof SIM_STATE_VERSION;
  savedAt: string;
  name?: string;
  simNowUs: number;
  nextId: number;
  gears: { id: number; state: GearState }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** Throws when `v` does not have the shape of the template `t` (built from a freshly created gear). */
function conforms(t: unknown, v: unknown, path: string): void {
  const bad = (what: string): never => { throw new Error(`${path}: ${what}`); };
  if (t === null) return;                                    // nullable fields are checked by the caller
  if (typeof t === 'number') { if (typeof v !== 'number' || !Number.isFinite(v)) bad('number expected'); return; }
  if (typeof t === 'boolean') { if (typeof v !== 'boolean') bad('boolean expected'); return; }
  if (typeof t === 'string') { if (typeof v !== 'string') bad('string expected'); return; }
  if (Array.isArray(t)) {
    if (!Array.isArray(v)) return bad('array expected');
    const proto = t.length ? t[0] : 0;
    v.forEach((e, i) => conforms(proto, e, `${path}[${i}]`));
    return;
  }
  if (isObj(t)) {
    if (!isObj(v)) return bad('object expected');
    for (const k of Object.keys(t)) {
      if (!(k in v)) bad(`missing "${k}"`);
      conforms(t[k], v[k], `${path}.${k}`);
    }
  }
}

const FADE = { startLevel: 0, targetLevel: 0, startUs: 0, durationUs: 0 };

/** Check one gear state from untrusted input and return a deep copy of it. */
export function validateGearState(raw: unknown, id: number): GearState {
  const where = `gear ${id}`;
  if (!isObj(raw)) throw new Error(`${where}: object expected`);
  if (!Array.isArray(raw['deviceTypes']) || !raw['deviceTypes'].every((d) => isInt(d, 0, 255))) throw new Error(`${where}.deviceTypes: list of device types expected`);
  const dt8 = isObj(raw['dt8']) ? raw['dt8'] : undefined;
  let tmpl: GearState;
  try {
    tmpl = createGearState(id, {
      deviceTypes: raw['deviceTypes'] as number[],
      colour: dt8 && isObj(dt8['cfg']) ? dt8['cfg'] as never : undefined
    });
  } catch (e) { throw new Error(`${where}: ${(e as Error).message}`); }
  conforms(tmpl, raw, where);

  const s = raw as unknown as GearState;
  if (s.shortAddress !== null && !isInt(s.shortAddress, 0, 63)) throw new Error(`${where}.shortAddress: 0..63 or null expected`);
  if (s.enableDeviceType !== null && !isInt(s.enableDeviceType, 0, 255)) throw new Error(`${where}.enableDeviceType: invalid`);
  if (s.scenes.length !== 16) throw new Error(`${where}.scenes: 16 entries expected`);
  if (s.fade !== null) conforms(FADE, s.fade, `${where}.fade`);
  if (s.dt8) {
    if (s.dt8.sceneColours.length !== 16) throw new Error(`${where}.dt8.sceneColours: 16 entries expected`);
    if (s.dt8.fade !== null) conforms({ from: tmpl.dt8!.actual, to: tmpl.dt8!.actual, startUs: 0, durationUs: 0 }, s.dt8.fade, `${where}.dt8.fade`);
    s.dt8.sceneColours.forEach((c, i) => {
      if (c !== null) conforms({ mode: '', values: tmpl.dt8!.actual }, c, `${where}.dt8.sceneColours[${i}]`);
    });
    if (s.dt8.tempMode !== null && typeof s.dt8.tempMode !== 'string') throw new Error(`${where}.dt8.tempMode: invalid`);
  }
  return structuredClone(s);
}

/** Parse and validate the text of a saved state. Throws an Error that says what is wrong. */
export function parseSimState(text: string): SimStateFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('Not a DALI Scout state file (invalid JSON)'); }
  if (!isObj(raw) || raw['format'] !== SIM_STATE_FORMAT) throw new Error('Not a DALI Scout state file');
  if (raw['version'] !== SIM_STATE_VERSION) throw new Error(`Unsupported state file version ${String(raw['version'])}`);
  if (typeof raw['simNowUs'] !== 'number' || !Number.isFinite(raw['simNowUs'])) throw new Error('simNowUs: number expected');
  if (!Array.isArray(raw['gears'])) throw new Error('gears: list expected');
  const ids = new Set<number>();
  const gears = raw['gears'].map((g: unknown) => {
    if (!isObj(g) || !isInt(g['id'], 0, 1_000_000)) throw new Error('gear without a valid id');
    if (ids.has(g['id'])) throw new Error(`duplicate gear id ${g['id']}`);
    ids.add(g['id']);
    return { id: g['id'], state: validateGearState(g['state'], g['id']) };
  });
  const nextId = isInt(raw['nextId'], 0, 1_000_001) ? raw['nextId'] : 0;
  return {
    format: SIM_STATE_FORMAT, version: SIM_STATE_VERSION,
    savedAt: typeof raw['savedAt'] === 'string' ? raw['savedAt'] : '',
    name: typeof raw['name'] === 'string' ? raw['name'] : undefined,
    simNowUs: raw['simNowUs'], nextId, gears
  };
}

/** Shift every absolute simulation time inside a gear by `delta` µs (0 means "not running" and stays 0). */
export function rebaseGearTimes(s: GearState, delta: number): void {
  if (s.initDeadlineUs) s.initDeadlineUs += delta;
  if (s.identifyUntilUs) s.identifyUntilUs += delta;
  if (s.fade) s.fade.startUs += delta;
  if (s.dt0?.referenceUntilUs) s.dt0.referenceUntilUs += delta;
  if (s.dt8?.fade) s.dt8.fade.startUs += delta;
}
