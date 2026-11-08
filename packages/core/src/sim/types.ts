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
}

export interface GearConfig {
  name?: string;
  shortAddress?: number | null;
  physicalMin?: number;
  deviceTypes?: number[];
  version?: number;
  faults?: Partial<GearFaults>;
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
