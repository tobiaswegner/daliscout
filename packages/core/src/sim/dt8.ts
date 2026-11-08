import {
  type ColourMode, type ColourValues, type Dt8Config, type Dt8Preset, type Dt8State, type GearState
} from './types.js';
import type { ExtContext, GearExtension } from './ext.js';
import { kelvinToXy, mirekToXy, mixPrimaries, xyInGamut, xyToRgb, type Rgb } from './color.js';

const MASK16 = 0xffff;
const MASK8 = 0xff;

const warm = kelvinToXy(2700);
const cool = kelvinToXy(6500);
/** Default chromaticities: sRGB R, G, B, warm white, cool white, amber. */
const DEFAULT_PRIMARIES = [
  { x: 0.64, y: 0.33 }, { x: 0.3, y: 0.6 }, { x: 0.15, y: 0.06 },
  { x: warm.x, y: warm.y }, { x: cool.x, y: cool.y }, { x: 0.57, y: 0.42 }
];
const RGBWAF_XY = [
  DEFAULT_PRIMARIES[0]!, DEFAULT_PRIMARIES[1]!, DEFAULT_PRIMARIES[2]!,
  { x: 0.3127, y: 0.329 }, { x: 0.57, y: 0.42 }, { x: cool.x, y: cool.y }  // W, A, F
];

export const DT8_PRESETS: Record<Dt8Preset, Dt8Config> = {
  rgb: { xy: true, tc: false, primaries: 3, rgbwaf: 3, physCoolestMirek: 0, physWarmestMirek: 0, primaryXy: DEFAULT_PRIMARIES },
  rgbw: { xy: true, tc: false, primaries: 4, rgbwaf: 4, physCoolestMirek: 0, physWarmestMirek: 0, primaryXy: DEFAULT_PRIMARIES },
  'rgb-ct': { xy: true, tc: true, primaries: 5, rgbwaf: 3, physCoolestMirek: 153, physWarmestMirek: 370, primaryXy: DEFAULT_PRIMARIES },
  tc: {
    xy: false, tc: true, primaries: 2, rgbwaf: 0, physCoolestMirek: 153, physWarmestMirek: 370,
    primaryXy: [DEFAULT_PRIMARIES[3]!, DEFAULT_PRIMARIES[4]!, ...DEFAULT_PRIMARIES.slice(2, 6)]
  },
  xy: { xy: true, tc: false, primaries: 3, rgbwaf: 0, physCoolestMirek: 0, physWarmestMirek: 0, primaryXy: DEFAULT_PRIMARIES }
};

export function resolveDt8Config(c: Dt8Preset | Partial<Dt8Config> | undefined): Dt8Config {
  const base = typeof c === 'string' ? DT8_PRESETS[c] : { ...DT8_PRESETS['rgb-ct'], ...c };
  return structuredClone(base) as Dt8Config;
}

const maskedValues = (n = 6): ColourValues => ({
  x: MASK16, y: MASK16, tc: MASK16, primary: new Array(n).fill(MASK16), rgbwaf: new Array(n).fill(MASK8), control: 0
});

/** Reset colour: D65-ish white (or 4000 K for Tc-only gear), channels at full for primaries/RGBWAF. */
function defaultValues(cfg: Dt8Config): ColourValues {
  const xy = cfg.xy ? { x: 0.3127, y: 0.329 } : mirekToXy(250);
  return {
    x: Math.round(xy.x * 65536), y: Math.round(xy.y * 65536),
    tc: Math.min(cfg.physWarmestMirek || 250, Math.max(cfg.physCoolestMirek || 250, 250)),
    primary: Array.from({ length: 6 }, (_, i) => (i < cfg.primaries ? 0xfffe : 0)),
    rgbwaf: Array.from({ length: 6 }, (_, i) => (i < cfg.rgbwaf ? 254 : 0)),
    control: 0
  };
}
const defaultMode = (c: Dt8Config): ColourMode => (c.xy ? 'xy' : c.tc ? 'tc' : c.primaries ? 'primary' : 'rgbwaf');

export function createDt8State(c: Dt8Preset | Partial<Dt8Config> | undefined): Dt8State {
  const cfg = resolveDt8Config(c);
  const vals = defaultValues(cfg);
  return {
    cfg, mode: defaultMode(cfg), actual: structuredClone(vals), temp: maskedValues(), tempMode: null,
    report: structuredClone(vals), fade: null,
    coolestMirek: cfg.physCoolestMirek, warmestMirek: cfg.physWarmestMirek,
    primaryXy: structuredClone(cfg.primaryXy), assigned: new Array(6).fill(0),
    sceneColours: new Array(16).fill(null), xyOutOfRange: false, tcOutOfRange: false
  };
}

/** The colour as display RGB at full brightness, for the UI. */
export function renderColour(d: Dt8State): Rgb {
  const v = d.actual;
  switch (d.mode) {
    case 'xy': return xyToRgb(v.x / 65536, v.y / 65536);
    case 'tc': { const p = mirekToXy(v.tc); return xyToRgb(p.x, p.y); }
    case 'primary': return mixPrimaries(d.primaryXy.slice(0, d.cfg.primaries), v.primary.map((l) => l / 0xfffe));
    case 'rgbwaf': return mixPrimaries(RGBWAF_XY.slice(0, d.cfg.rgbwaf), v.rgbwaf.map((l) => l / 254));
  }
}

const u16 = (s: GearState) => ((s.dtr1 << 8) | s.dtr0) & 0xffff;

/** Merge `src` into `dst` ignoring MASK values (MASK = "leave unchanged"). */
function merge(dst: ColourValues, src: ColourValues): ColourValues {
  const out = structuredClone(dst);
  if (src.x !== MASK16) out.x = src.x;
  if (src.y !== MASK16) out.y = src.y;
  if (src.tc !== MASK16) out.tc = src.tc;
  src.primary.forEach((v, i) => { if (v !== MASK16) out.primary[i] = v; });
  src.rgbwaf.forEach((v, i) => { if (v !== MASK8) out.rgbwaf[i] = v; });
  if (src.control) out.control = src.control;
  return out;
}

const lerp = (a: number, b: number, p: number) => Math.round(a + (b - a) * p);

function interpolate(f: NonNullable<Dt8State['fade']>, p: number): ColourValues {
  return {
    x: lerp(f.from.x, f.to.x, p), y: lerp(f.from.y, f.to.y, p), tc: lerp(f.from.tc, f.to.tc, p),
    primary: f.from.primary.map((v, i) => lerp(v, f.to.primary[i]!, p)),
    rgbwaf: f.from.rgbwaf.map((v, i) => lerp(v, f.to.rgbwaf[i]!, p)),
    control: f.to.control
  };
}

/** Twice-sent (configuration) commands: STORE ... / ASSIGN / START AUTO CALIBRATION. */
const TWICE = new Set([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5]);

function validate(d: Dt8State): void {
  d.xyOutOfRange = d.mode === 'xy' && !xyInGamut(d.actual.x / 65536, d.actual.y / 65536);
  const lo = d.coolestMirek, hi = d.warmestMirek;
  d.tcOutOfRange = d.mode === 'tc' && hi > 0 && (d.actual.tc < lo || d.actual.tc > hi);
}

/** Apply the temporary registers to the actual colour, fading over the gear's fade time. */
function activate(d: Dt8State, ctx: ExtContext): void {
  if (!d.tempMode) return;
  const target = merge(d.report, d.temp);
  if (d.tempMode === 'tc' && d.coolestMirek > 0) target.tc = Math.min(d.warmestMirek, Math.max(d.coolestMirek, target.tc));
  d.mode = d.tempMode;
  d.report = target;
  d.temp = maskedValues();
  d.tempMode = null;
  if (ctx.fadeUs > 0) d.fade = { from: structuredClone(d.actual), to: structuredClone(target), startUs: ctx.t.simUs, durationUs: ctx.fadeUs };
  else { d.actual = structuredClone(target); d.fade = null; }
  validate(d);
}

function setTemp(d: Dt8State, mode: ColourMode, patch: (t: ColourValues) => void): void {
  patch(d.temp);
  d.tempMode = mode;
}

/** Selector for QUERY COLOUR VALUE (DTR0): +0 actual, +128 temporary, +192 report. */
function colourValue(d: Dt8State, sel: number): number | undefined {
  const set = sel >= 192 ? d.report : sel >= 128 ? d.temp : d.actual;
  const base = sel >= 192 ? sel - 192 : sel >= 128 ? sel - 128 : sel;
  if (base === 0) return set.x;
  if (base === 1) return set.y;
  if (base === 2) return set.tc;
  if (base >= 3 && base <= 8) return set.primary[base - 3];
  if (base >= 64 && base <= 69) return set.rgbwaf[base - 64];
  if (base === 70) return set.control;
  return undefined;
}

export const dt8: GearExtension = {
  deviceType: 8,

  command(op: number, ctx: ExtContext): number | undefined {
    const s = ctx.s, d = s.dt8;
    if (!d) return undefined;
    const cfg = d.cfg;
    if (TWICE.has(op) && !ctx.twice()) return undefined;
    const changed = () => { validate(d); ctx.changed(); };

    switch (op) {
      case 0xe0: if (cfg.xy) setTemp(d, 'xy', (t) => { t.x = u16(s); }); break;                    // SET TEMPORARY X
      case 0xe1: if (cfg.xy) setTemp(d, 'xy', (t) => { t.y = u16(s); }); break;                    // SET TEMPORARY Y
      case 0xe2: activate(d, ctx); changed(); return undefined;                                      // ACTIVATE
      case 0xe3: case 0xe4: case 0xe5: case 0xe6: {                                                  // X/Y STEP UP/DOWN
        if (!cfg.xy) break;
        const dir = op === 0xe3 || op === 0xe5 ? 1 : -1;
        const key = op <= 0xe4 ? 'x' : 'y';
        const cur = d.mode === 'xy' ? d.report : d.actual;
        const v = Math.min(0xfffe, Math.max(0, cur[key] + dir));
        d.report = { ...d.report, [key]: v }; d.actual = { ...d.actual, [key]: v }; d.mode = 'xy'; d.fade = null;
        changed(); return undefined;
      }
      case 0xe7: if (cfg.tc) setTemp(d, 'tc', (t) => { t.tc = u16(s); }); break;                    // SET TEMPORARY Tc
      case 0xe8: case 0xe9: {                                                                        // Tc STEP COOLER / WARMER
        if (!cfg.tc) break;
        const dir = op === 0xe8 ? -1 : 1;
        const lo = d.coolestMirek || 1, hi = d.warmestMirek || 0xfffe;
        const v = Math.min(hi, Math.max(lo, (d.mode === 'tc' ? d.report.tc : d.actual.tc) + dir));
        d.report = { ...d.report, tc: v }; d.actual = { ...d.actual, tc: v }; d.mode = 'tc'; d.fade = null;
        changed(); return undefined;
      }
      case 0xea: {                                                                                   // SET TEMPORARY PRIMARY N DIMLEVEL
        const n = s.dtr2;
        if (n < cfg.primaries) setTemp(d, 'primary', (t) => { t.primary[n] = u16(s); });
        else if (n === 255) setTemp(d, 'primary', (t) => { for (let i = 0; i < cfg.primaries; i++) t.primary[i] = u16(s); });
        break;
      }
      case 0xeb: if (cfg.rgbwaf >= 3) setTemp(d, 'rgbwaf', (t) => { t.rgbwaf[0] = s.dtr0; t.rgbwaf[1] = s.dtr1; t.rgbwaf[2] = s.dtr2; }); break; // RGB
      case 0xec: if (cfg.rgbwaf > 3) setTemp(d, 'rgbwaf', (t) => {                                    // WAF
        if (cfg.rgbwaf > 3) t.rgbwaf[3] = s.dtr0;
        if (cfg.rgbwaf > 4) t.rgbwaf[4] = s.dtr1;
        if (cfg.rgbwaf > 5) t.rgbwaf[5] = s.dtr2;
      }); break;
      case 0xed: if (cfg.rgbwaf) setTemp(d, 'rgbwaf', (t) => { t.control = s.dtr0; }); break;         // SET TEMPORARY RGBWAF CONTROL
      case 0xee: d.temp = structuredClone(d.report); d.tempMode = d.mode; break;                      // COPY REPORT TO TEMPORARY
      case 0xf0: s.resetState = false; break;                                                         // STORE TY PRIMARY N (luminous flux is not simulated)
      case 0xf1: {                                                                                   // STORE XY-COORDINATE PRIMARY N
        const n = s.dtr2;
        if (n < cfg.primaries && d.temp.x !== MASK16 && d.temp.y !== MASK16) {
          d.primaryXy[n] = { x: d.temp.x / 65536, y: d.temp.y / 65536 };
        }
        s.resetState = false; break;
      }
      case 0xf2: {                                                                                   // STORE COLOUR TEMPERATURE Tc LIMIT
        if (!cfg.tc) break;
        const v = u16(s);
        const lo = cfg.physCoolestMirek, hi = cfg.physWarmestMirek;
        if (s.dtr2 === 0) d.coolestMirek = Math.min(d.warmestMirek, Math.max(lo, v));       // coolest (smallest mirek)
        else if (s.dtr2 === 1) d.warmestMirek = Math.max(d.coolestMirek, Math.min(hi, v));  // warmest
        s.resetState = false; break;
      }
      case 0xf3: s.resetState = false; break;                                                         // STORE GEAR FEATURES/STATUS (accepted, no effect)
      case 0xf4: if (s.dtr2 < 6) d.assigned[s.dtr2] = s.dtr0; s.resetState = false; break;           // ASSIGN COLOUR TO LINKED CHANNEL
      case 0xf5: s.resetState = false; break;                                                         // START AUTO CALIBRATION (instant)
      case 0xf7: return 0;                                                                           // QUERY GEAR FEATURES/STATUS
      case 0xf8:                                                                                     // QUERY COLOUR STATUS
        return (d.xyOutOfRange ? 1 : 0) | (d.tcOutOfRange ? 2 : 0) |
          (d.mode === 'xy' ? 16 : 0) | (d.mode === 'tc' ? 32 : 0) | (d.mode === 'primary' ? 64 : 0) | (d.mode === 'rgbwaf' ? 128 : 0);
      case 0xf9:                                                                                     // QUERY COLOUR TYPE FEATURES
        return (cfg.xy ? 1 : 0) | (cfg.tc ? 2 : 0) | (cfg.primaries << 2) | (cfg.rgbwaf << 5);
      case 0xfa: {                                                                                   // QUERY COLOUR VALUE
        const v = colourValue(d, s.dtr0);
        if (v === undefined) return undefined;
        s.dtr1 = (v >> 8) & 0xff; s.dtr0 = v & 0xff;
        return (v >> 8) & 0xff;
      }
      case 0xfb: return d.actual.control;                                                            // QUERY RGBWAF CONTROL
      case 0xfc: return d.assigned[s.dtr0] ?? undefined;                                             // QUERY ASSIGNED COLOUR
      case 0xff: return 1;                                                                           // QUERY EXTENDED VERSION NUMBER
      default: return undefined;
    }
    ctx.changed();
    return undefined;
  },

  advance(simUs: number, s: GearState): boolean {
    const d = s.dt8;
    if (!d?.fade) return false;
    const p = (simUs - d.fade.startUs) / d.fade.durationUs;
    if (p >= 1) { d.actual = structuredClone(d.fade.to); d.fade = null; }
    else d.actual = interpolate(d.fade, Math.max(0, p));
    validate(d);
    return true;
  },

  reset(s: GearState): void {
    const d = s.dt8;
    if (!d) return;
    const fresh = createDt8State(d.cfg);
    s.dt8 = { ...fresh, cfg: d.cfg, primaryXy: d.primaryXy, assigned: d.assigned };
  },

  scene(kind, n, ctx): void {
    const d = ctx.s.dt8;
    if (!d) return;
    if (kind === 'store') {
      if (d.tempMode) d.sceneColours[n] = { mode: d.tempMode, values: merge(d.report, d.temp) };
    } else if (kind === 'remove') d.sceneColours[n] = null;
    else {
      const sc = d.sceneColours[n];
      if (!sc) return;
      d.temp = structuredClone(sc.values); d.tempMode = sc.mode;
      activate(d, ctx);
      ctx.changed();
    }
  }
};

