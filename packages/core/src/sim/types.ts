/** Serialisable state of one simulated DALI control gear (IEC 62386-102). */

/** 255 / MASK: "no value", used by levels, scenes and the short address on the wire. */
export const NO_VALUE = 255;
export const YES = 255;

export type InitState = 'disabled' | 'enabled' | 'withdrawn';

export interface FadeState {
  startLevel: number;
  targetLevel: number;
  /** Simulation time (µs) the fade started. */
  startUs: number;
  durationUs: number;
}

// ---- DT8 (IEC 62386-209 colour control) ---------------------------------------------------

export type ColourMode = 'xy' | 'tc' | 'primary' | 'rgbwaf';
export type Dt8Preset = 'rgb' | 'rgbw' | 'rgb-ct' | 'tc' | 'xy';

/** Which colour types a DT8 gear supports and its physical properties. */
export interface Dt8Config {
  xy: boolean;
  tc: boolean;
  /** Number of primaries (colour type "primary N"), 0..6. */
  primaries: number;
  /** Number of RGBWAF channels, 0..6 (R, G, B, W, A, F). */
  rgbwaf: number;
  /** Physical colour temperature range in mirek (coolest = smallest mirek). */
  physCoolestMirek: number;
  physWarmestMirek: number;
  /** Chromaticity of each of the 6 primaries (only the first `primaries` are used). */
  primaryXy: { x: number; y: number }[];
}

/** One complete set of colour register values. 16-bit registers use 0xFFFF as MASK. */
export interface ColourValues {
  /** CIE x/y * 65536. */
  x: number;
  y: number;
  /** Colour temperature in mirek. */
  tc: number;
  /** 16-bit drive level per primary. */
  primary: number[];
  /** 8-bit level (0..254) per RGBWAF channel. */
  rgbwaf: number[];
  /** RGBWAF control byte. */
  control: number;
}

export interface ColourFade {
  from: ColourValues;
  to: ColourValues;
  startUs: number;
  durationUs: number;
}

export interface Dt8State {
  cfg: Dt8Config;
  /** Colour type the gear is currently displaying. */
  mode: ColourMode;
  actual: ColourValues;
  /** Temporary registers, applied by ACTIVATE. */
  temp: ColourValues;
  /** Which colour type was last written to the temporary registers (null = none since ACTIVATE). */
  tempMode: ColourMode | null;
  /** Colour the actual colour is heading for (equals actual when not fading). */
  report: ColourValues;
  fade: ColourFade | null;
  /** Configured Tc limits in mirek (coolest <= warmest). */
  coolestMirek: number;
  warmestMirek: number;
  /** Stored chromaticity of each primary (STORE XY-COORDINATE PRIMARY N). */
  primaryXy: { x: number; y: number }[];
  /** Channel assignments (ASSIGN COLOUR TO LINKED CHANNEL). */
  assigned: number[];
  /** Per-scene colour, captured by SET SCENE; null = scene has no colour. */
  sceneColours: ({ mode: ColourMode; values: ColourValues } | null)[];
  xyOutOfRange: boolean;
  tcOutOfRange: boolean;
}

// ---- DT0 (IEC 62386-201 fluorescent lamp) -------------------------------------------------

export interface Dt0State {
  /** 0 = standard (logarithmic) dimming curve, 1 = linear. */
  dimmingCurve: 0 | 1;
  currentProtector: boolean;
  /** Fast fade time in 25 ms units (0 = not set). */
  fastFadeTime: number;
  minFastFadeTime: number;
  /** Time until which a REFERENCE SYSTEM POWER measurement runs (0 = not running). */
  referenceUntilUs: number;
  referencePowerDone: boolean;
}

export interface GearFaults {
  /** Lamp does not light: status "lamp failure", arc power never reported on. */
  lampFailure: boolean;
  /** Gear is disconnected: ignores every frame. */
  offline: boolean;
  /** Gear executes commands but never answers queries. */
  noAnswer: boolean;
}

export interface GearState {
  name: string;
  /** 0..63, or null when unassigned. */
  shortAddress: number | null;
  /** 24-bit. */
  randomAddress: number;
  /** 24-bit search address register. */
  searchAddress: number;
  /** Bit n set = member of group n. */
  groups: number;
  /** Device types this gear implements (0 = fluorescent, 8 = colour, ...). */
  deviceTypes: number[];
  /** Index into deviceTypes for QUERY NEXT DEVICE TYPE. */
  nextDeviceTypeIndex: number;
  /** 102 version number reported by QUERY VERSION NUMBER. */
  version: number;

  dtr0: number;
  dtr1: number;
  dtr2: number;

  actualLevel: number;
  targetLevel: number;
  lastActiveLevel: number;
  minLevel: number;
  maxLevel: number;
  physicalMin: number;
  powerOnLevel: number;
  systemFailureLevel: number;
  /** 16 scene levels, 255 = not in scene. */
  scenes: number[];
  /** 0..15, 0 = no fade. */
  fadeTime: number;
  /** 1..15. */
  fadeRate: number;
  /** bits 6-4 multiplier (0..4), bits 3-0 base; 0 = unused. */
  extendedFadeTime: number;
  fade: FadeState | null;

  limitError: boolean;
  resetState: boolean;
  powerFailure: boolean;
  operatingMode: number;

  init: InitState;
  /** Simulation time at which the initialisation state expires. */
  initDeadlineUs: number;

  /** Device type enabled for the next frame (ENABLE DEVICE TYPE), if any. */
  enableDeviceType: number | null;
  writeEnabled: boolean;
  /** Simulation time until which IDENTIFY DEVICE is shown. */
  identifyUntilUs: number;
  /** Memory banks; bank 0 is read-only identification data. */
  memory: number[][];

  faults: GearFaults;

  /** Present on gear with device type 8. */
  dt8?: Dt8State;
  /** Present on gear with device type 0. */
  dt0?: Dt0State;
}

export interface GearConfig {
  name?: string;
  shortAddress?: number | null;
  physicalMin?: number;
  deviceTypes?: number[];
  version?: number;
  faults?: Partial<GearFaults>;
  /** DT8 colour capabilities: a preset name or explicit values. Implies device type 8. */
  colour?: Dt8Preset | Partial<Dt8Config>;
}

export interface Times {
  /** Bus time in µs, for the 100 ms send-twice window. */
  busUs: number;
  /** Simulation time in µs, for fades and timers. */
  simUs: number;
}

export type SimReply =
  | { kind: 'none' }
  | { kind: 'answer'; byte: number }
  /** Several gears answered with different values. */
  | { kind: 'collision' };
