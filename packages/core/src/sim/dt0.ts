import { YES, type Dt0State, type GearState } from './types.js';
import type { ExtContext, GearExtension } from './ext.js';

const REFERENCE_RUN_US = 15 * 1_000_000;
/** REFERENCE SYSTEM POWER, ENABLE/DISABLE CURRENT PROTECTOR, SELECT DIMMING CURVE, STORE DTR AS FAST FADE TIME */
const TWICE = new Set([0xe0, 0xe1, 0xe2, 0xe3, 0xe4]);

export function createDt0State(): Dt0State {
  return {
    dimmingCurve: 0, currentProtector: true, fastFadeTime: 0, minFastFadeTime: 1,
    referenceUntilUs: 0, referencePowerDone: false
  };
}

/** Fluorescent lamp gear (IEC 62386-201): lamp-specific settings and queries. */
export const dt0: GearExtension = {
  deviceType: 0,

  command(op: number, ctx: ExtContext): number | undefined {
    const d = ctx.s.dt0;
    if (!d) return undefined;
    if (TWICE.has(op) && !ctx.twice()) return undefined;
    const dtr0 = ctx.s.dtr0;
    switch (op) {
      case 0xe0: // REFERENCE SYSTEM POWER
        d.referenceUntilUs = ctx.t.simUs + REFERENCE_RUN_US; d.referencePowerDone = false; break;
      case 0xe1: d.currentProtector = true; break;               // ENABLE CURRENT PROTECTOR
      case 0xe2: d.currentProtector = false; break;              // DISABLE CURRENT PROTECTOR
      case 0xe3: if (dtr0 <= 1) d.dimmingCurve = dtr0 as 0 | 1; break; // SELECT DIMMING CURVE
      case 0xe4: d.fastFadeTime = dtr0 === 0 ? 0 : Math.max(d.minFastFadeTime, Math.min(27, dtr0)); break; // STORE DTR AS FAST FADE TIME
      case 0xed: return 0;                                       // QUERY GEAR TYPE (plain ballast)
      case 0xee: return d.dimmingCurve;                          // QUERY DIMMING CURVE
      case 0xef: return 0b0000_0001;                             // QUERY POSSIBLE OPERATING MODES
      case 0xf0: return ctx.s.operatingMode;                     // QUERY OPERATING MODE
      case 0xf1: return d.fastFadeTime;                          // QUERY FAST FADE TIME
      case 0xf2: return d.minFastFadeTime;                       // QUERY MIN FAST FADE TIME
      case 0xf3: return 1;                                       // QUERY EXTENDED VERSION NUMBER
      case 0xf4: return d.currentProtector ? YES : undefined;    // QUERY CURRENT PROTECTOR (enabled)
      default: return undefined;
    }
    if (op < 0xe5) { ctx.s.resetState = false; ctx.changed(); }
    return undefined;
  },

  advance(simUs: number, s: GearState): boolean {
    const d = s.dt0;
    if (d && d.referenceUntilUs && simUs >= d.referenceUntilUs) {
      d.referenceUntilUs = 0; d.referencePowerDone = true;
      return true;
    }
    return false;
  },

  reset(s: GearState): void {
    if (!s.dt0) return;
    s.dt0 = { ...createDt0State(), referencePowerDone: s.dt0.referencePowerDone };
  }
};
