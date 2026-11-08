import { levelToPercent } from '../level.js';
import { renderColour } from './dt8.js';
import type { GearState } from './types.js';
import type { Rgb } from './color.js';

/** Perceived light output 0..1: lamp failure = 0, DT0 linear dimming curve = level/254, else the log curve. */
export function gearBrightness(s: GearState): number {
  if (s.faults.lampFailure || s.actualLevel <= 0) return 0;
  if (s.dt0?.dimmingCurve === 1) return s.actualLevel / 254;
  return levelToPercent(s.actualLevel) / 100;
}

/** Colour of the emitted light at full brightness: DT8 colour state, or warm white for other gear. */
export function gearColour(s: GearState): Rgb {
  return s.dt8 ? renderColour(s.dt8) : s.dt0 ? [255, 244, 229] : [255, 214, 140];
}

/** Short label of a DT8 gear's capabilities, e.g. "RGB+CT". */
export function colourLabel(s: GearState): string | null {
  const c = s.dt8?.cfg;
  if (!c) return null;
  if (c.tc && c.xy) return 'RGB+CT';
  if (c.tc) return 'CT';
  if (c.primaries >= 4 || c.rgbwaf >= 4) return 'RGBW';
  if (c.primaries === 3) return c.xy && !c.rgbwaf ? 'xy' : 'RGB';
  return 'colour';
}
