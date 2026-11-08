import { lookupCommand, lookupSpecial } from '../commands.js';
import { fadeDurationUs, fadeRateStepsPerSecond } from './fade.js';
import { NO_VALUE, YES, type GearConfig, type GearState, type Times } from './types.js';

const TWICE_WINDOW_US = 100_000;
const INIT_TIMEOUT_US = 15 * 60 * 1_000_000;
const IDENTIFY_US = 10 * 1_000_000;
const UP_DOWN_US = 200_000;

/** Power-on / reset values (IEC 62386-102 table of default values). */
function applyResetValues(s: GearState): void {
  s.randomAddress = 0xffffff;
  s.searchAddress = 0xffffff;
  s.groups = 0;
  s.minLevel = s.physicalMin;
  s.maxLevel = 254;
  s.powerOnLevel = 254;
  s.systemFailureLevel = NO_VALUE;
  s.scenes = new Array(16).fill(NO_VALUE);
  s.fadeTime = 0;
  s.fadeRate = 7;
  s.extendedFadeTime = 0;
  s.operatingMode = 0;
  s.limitError = false;
  s.resetState = true;
}

/** Memory bank 0 (read-only identification data), laid out as in IEC 62386-102 ed.2. */
function bank0(id: number, version: number): number[] {
  const b = new Array<number>(0x1b).fill(0);
  b[0x00] = 0x1a;            // last accessible location
  b[0x01] = 0x00;            // indicator byte
  b[0x02] = 0x01;            // last accessible bank
  for (let i = 0; i < 6; i++) b[0x03 + i] = 0;                 // GTIN
  b[0x09] = 1; b[0x0a] = 0;  // firmware version 1.0
  for (let i = 0; i < 8; i++) b[0x0b + i] = (id >> ((7 - i) * 8)) & 0xff; // identification number
  b[0x13] = 1; b[0x14] = 0;  // hardware version 1.0
  b[0x15] = 0x08;            // IEC 62386-101 version 2.0
  b[0x16] = version;         // IEC 62386-102 version
  b[0x17] = 0xff;            // IEC 62386-103 version (none)
  b[0x18] = 0;               // logical control device units
  b[0x19] = 1;               // logical control gear units
  b[0x1a] = 0;               // index of this unit
  return b;
}

export function createGearState(id: number, cfg: GearConfig = {}): GearState {
  const physicalMin = cfg.physicalMin ?? 1;
  const version = cfg.version ?? 8;
  const s: GearState = {
    name: cfg.name ?? `Gear ${id + 1}`,
    shortAddress: cfg.shortAddress === undefined ? null : cfg.shortAddress,
    randomAddress: 0xffffff, searchAddress: 0xffffff, groups: 0,
    deviceTypes: [...(cfg.deviceTypes ?? [])], nextDeviceTypeIndex: 0, version,
    dtr0: 0, dtr1: 0, dtr2: 0,
    actualLevel: 254, targetLevel: 254, lastActiveLevel: 254,
    minLevel: physicalMin, maxLevel: 254, physicalMin, powerOnLevel: 254, systemFailureLevel: NO_VALUE,
    scenes: new Array(16).fill(NO_VALUE), fadeTime: 0, fadeRate: 7, extendedFadeTime: 0, fade: null,
    limitError: false, resetState: true, powerFailure: true, operatingMode: 0,
    init: 'disabled', initDeadlineUs: 0, enableDeviceType: null, writeEnabled: false, identifyUntilUs: 0,
    memory: [bank0(id + 1, version), [0x03, 0x00, 0xff, 0x00]],
    faults: { lampFailure: false, offline: false, noAnswer: false, ...cfg.faults }
  };
  return s;
}

export type Rng = () => number;

/**
 * One DALI control gear. Deterministic: all behaviour is a function of the frames it is fed and
 * the two clocks passed in (`busUs` for the send-twice window, `simUs` for fades and timers).
 */
export class Gear {
  readonly s: GearState;
  /** Called after every state mutation, so a host can push updates to a UI. */
  onChange?: () => void;
  private pending: { a: number; d: number; busUs: number } | null = null;

  constructor(readonly id: number, cfg: GearConfig = {}, private readonly rng: Rng = Math.random) {
    this.s = createGearState(id, cfg);
  }

  snapshot(): GearState {
    return structuredClone(this.s);
  }

  private changed(): void { this.onChange?.(); }

  // ---- derived values -------------------------------------------------------------------

  get lampOn(): boolean { return this.s.actualLevel > 0 && !this.s.faults.lampFailure; }
  get selected(): boolean { return this.s.randomAddress === this.s.searchAddress; }

  statusByte(): number {
    const s = this.s;
    return (
      (0) |
      (s.faults.lampFailure ? 2 : 0) |
      (this.lampOn ? 4 : 0) |
      (s.limitError ? 8 : 0) |
      (s.fade ? 16 : 0) |
      (s.resetState ? 32 : 0) |
      (s.shortAddress === null ? 64 : 0) |
      (s.powerFailure ? 128 : 0)
    );
  }

  // ---- time -----------------------------------------------------------------------------

  /** Advance fades and timers to `simUs`. Returns true if the visible state changed. */
  advance(simUs: number): boolean {
    const s = this.s;
    let dirty = false;
    if (s.init !== 'disabled' && simUs >= s.initDeadlineUs) { s.init = 'disabled'; dirty = true; }
    if (s.identifyUntilUs && simUs >= s.identifyUntilUs) { s.identifyUntilUs = 0; dirty = true; }
    const f = s.fade;
    if (f) {
      const p = (simUs - f.startUs) / f.durationUs;
      if (p >= 1) { s.actualLevel = f.targetLevel; s.fade = null; }
      else {
        // fading to/from off passes through the minimum level
        const from = f.startLevel === 0 ? s.minLevel : f.startLevel;
        const to = f.targetLevel === 0 ? s.minLevel : f.targetLevel;
        s.actualLevel = Math.round(from + (to - from) * Math.max(0, p));
      }
      dirty = true;
    }
    if (dirty) this.changed();
    return dirty;
  }

  // ---- direct manipulation (UI / tests) --------------------------------------------------

  /** Set the level immediately, bypassing the protocol (manual control in the UI). */
  forceLevel(level: number): void {
    const s = this.s;
    const l = Math.max(0, Math.min(254, Math.round(level)));
    s.fade = null; s.actualLevel = l; s.targetLevel = l;
    if (l > 0) s.lastActiveLevel = l;
    this.changed();
  }

  setFault(patch: Partial<GearState['faults']>): void {
    Object.assign(this.s.faults, patch);
    this.changed();
  }

  /** Remove power and restore it: persistent values are kept, volatile state is lost. */
  powerCycle(): void {
    const s = this.s;
    s.fade = null; s.init = 'disabled'; s.initDeadlineUs = 0; s.enableDeviceType = null;
    s.writeEnabled = false; s.identifyUntilUs = 0; s.powerFailure = true;
    this.pending = null;
    const lvl = s.powerOnLevel === NO_VALUE ? s.lastActiveLevel : s.powerOnLevel;
    s.actualLevel = s.targetLevel = lvl === 0 ? 0 : Math.max(s.minLevel, Math.min(s.maxLevel, lvl));
    this.changed();
  }

  // ---- frame handling -------------------------------------------------------------------

  /**
   * Process one forward frame. Returns the answer byte if this gear answers, otherwise undefined.
   * Frames that are not 16 bits long are ignored (24-bit frames belong to control devices).
   */
  process(data: Uint8Array, bits: number, t: Times): number | undefined {
    const s = this.s;
    if (s.faults.offline) return undefined;
    this.advance(t.simUs);
    if (bits !== 16 || data.length !== 2) { this.pending = null; return undefined; }
    const a = data[0]!, d = data[1]!;

    const dt = s.enableDeviceType;
    if (a !== 0xc1) s.enableDeviceType = null; // ENABLE DEVICE TYPE only applies to the next frame
    // write access survives only memory writes, DTR loads and ENABLE WRITE MEMORY itself
    const isAddress = a < 0xa0 || a >= 0xfc;
    const keepsWrite = isAddress ? (a & 1) === 1 && d === 0x81
      : a === 0xa3 || a === 0xc1 || a === 0xc3 || a === 0xc5 || a === 0xc7 || a === 0xc9;
    if (!keepsWrite) s.writeEnabled = false;

    const again = !!this.pending && this.pending.a === a && this.pending.d === d &&
      t.busUs - this.pending.busUs <= TWICE_WINDOW_US;
    if (!again) this.pending = null;

    let answer: number | undefined;
    if (a >= 0xa0 && a <= 0xfb) {
      answer = this.special(a, d, again, t);
    } else {
      const sel = a & 1;
      if (!this.matches(a)) return undefined;
      answer = sel ? this.command(a, d, dt, again, t) : this.dapc(d, t);
    }
    return s.faults.noAnswer ? undefined : answer;
  }

  private matches(a: number): boolean {
    const s = this.s;
    if ((a & 0x80) === 0) return s.shortAddress === ((a >> 1) & 0x3f);
    if ((a & 0xe0) === 0x80) return (s.groups & (1 << ((a >> 1) & 0x0f))) !== 0;
    if (a >= 0xfe) return true;                       // broadcast
    if (a >= 0xfc) return s.shortAddress === null;    // broadcast unaddressed
    return false;
  }

  /** Returns true when the command must run now; false when it only armed the send-twice window. */
  private twice(a: number, d: number, again: boolean, t: Times): boolean {
    if (again) { this.pending = null; return true; }
    this.pending = { a, d, busUs: t.busUs };
    return false;
  }

  // ---- level control --------------------------------------------------------------------

  private fadeUs(): number { return fadeDurationUs(this.s.fadeTime, this.s.extendedFadeTime); }

  private startFade(target: number, durationUs: number, simUs: number): void {
    const s = this.s;
    s.targetLevel = target;
    if (durationUs <= 0 || target === s.actualLevel) { s.actualLevel = target; s.fade = null; }
    else s.fade = { startLevel: s.actualLevel, targetLevel: target, startUs: simUs, durationUs };
  }

  /** Go to a level using the fade time (DAPC, scenes, last active level). */
  private goTo(level: number, t: Times): void {
    const s = this.s;
    s.powerFailure = false;
    if (level === NO_VALUE) { s.fade = null; s.targetLevel = s.actualLevel; this.changed(); return; } // stop fade
    let target = level;
    s.limitError = false;
    if (level > 0) {
      if (level < s.minLevel) { target = s.minLevel; s.limitError = true; }
      else if (level > s.maxLevel) { target = s.maxLevel; s.limitError = true; }
      s.lastActiveLevel = target;
    }
    this.startFade(target, this.fadeUs(), t.simUs);
    this.changed();
  }

  private immediate(level: number): void {
    const s = this.s;
    s.powerFailure = false;
    s.fade = null; s.actualLevel = s.targetLevel = level;
    if (level > 0) s.lastActiveLevel = level;
    this.changed();
  }

  private dapc(level: number, t: Times): undefined {
    this.goTo(level, t);
    return undefined;
  }

  private upDown(dir: 1 | -1, t: Times): void {
    const s = this.s;
    s.powerFailure = false;
    if (s.actualLevel === 0) return;
    const steps = Math.max(1, Math.round(fadeRateStepsPerSecond(s.fadeRate) * (UP_DOWN_US / 1e6)));
    const from = s.fade ? s.fade.targetLevel : s.actualLevel;
    const target = dir > 0 ? Math.min(s.maxLevel, from + steps) : Math.max(s.minLevel, from - steps);
    if (target === s.actualLevel) { this.changed(); return; }
    s.lastActiveLevel = target;
    this.startFade(target, UP_DOWN_US, t.simUs);
    this.changed();
  }

  // ---- standard commands (S = 1) ---------------------------------------------------------

  private command(a: number, op: number, dt: number | null, again: boolean, t: Times): number | undefined {
    const s = this.s;

    if (op >= 0xe0 && dt !== null) return this.extended(dt, op);

    const def = lookupCommand(op)?.def;
    if (def?.sendTwice && !this.twice(a, op, again, t)) return undefined;

    const yesIf = (c: boolean) => (c ? YES : undefined);
    const config = () => { s.resetState = false; };

    // --- arc power control (0x00-0x1F)
    if (op <= 0x0a) {
      switch (op) {
        case 0x00: this.immediate(0); break;                                  // OFF
        case 0x01: this.upDown(1, t); break;                                  // UP
        case 0x02: this.upDown(-1, t); break;                                 // DOWN
        case 0x03: if (s.actualLevel > 0 && s.actualLevel < s.maxLevel) this.immediate(s.actualLevel + 1); break; // STEP UP
        case 0x04: if (s.actualLevel > s.minLevel) this.immediate(s.actualLevel - 1); break;                       // STEP DOWN
        case 0x05: this.immediate(s.maxLevel); break;                         // RECALL MAX
        case 0x06: this.immediate(s.minLevel); break;                         // RECALL MIN
        case 0x07: // STEP DOWN AND OFF
          if (s.actualLevel > s.minLevel) this.immediate(s.actualLevel - 1);
          else if (s.actualLevel > 0) this.immediate(0);
          break;
        case 0x08: // ON AND STEP UP
          if (s.actualLevel === 0) this.immediate(s.minLevel);
          else if (s.actualLevel < s.maxLevel) this.immediate(s.actualLevel + 1);
          break;
        case 0x09: break;                                                     // ENABLE DAPC SEQUENCE
        case 0x0a: this.goTo(s.lastActiveLevel, t); break;                    // GO TO LAST ACTIVE LEVEL
      }
      return undefined;
    }
    if (op >= 0x10 && op <= 0x1f) {                                           // GO TO SCENE
      const lvl = s.scenes[op & 0x0f]!;
      if (lvl !== NO_VALUE) this.goTo(lvl, t);
      return undefined;
    }

    // --- configuration (0x20-0x8F): only reached on the second frame
    if (op >= 0x20 && op <= 0x8f) {
      const dtr0 = s.dtr0;
      switch (true) {
        case op === 0x20: this.reset(); return undefined;
        case op === 0x21: s.dtr0 = s.actualLevel; this.changed(); return undefined;
        case op === 0x23: s.operatingMode = dtr0; config(); break;
        case op === 0x25: s.identifyUntilUs = t.simUs + IDENTIFY_US; break;
        case op === 0x2a: s.maxLevel = Math.max(s.minLevel, Math.min(254, dtr0 === NO_VALUE ? 254 : dtr0)); this.reclamp(); config(); break;
        case op === 0x2b: s.minLevel = Math.max(s.physicalMin, Math.min(s.maxLevel, dtr0 === NO_VALUE ? s.physicalMin : dtr0)); this.reclamp(); config(); break;
        case op === 0x2c: s.systemFailureLevel = dtr0; config(); break;
        case op === 0x2d: s.powerOnLevel = dtr0; config(); break;
        case op === 0x2e: s.fadeTime = Math.min(15, dtr0); config(); break;
        case op === 0x2f: s.fadeRate = Math.max(1, Math.min(15, dtr0)); config(); break;
        case op === 0x30: {
          const mult = (dtr0 >> 4) & 7;
          s.extendedFadeTime = mult > 4 ? 0 : (mult << 4) | (dtr0 & 15);
          config(); break;
        }
        case op >= 0x40 && op <= 0x4f: s.scenes[op & 0x0f] = dtr0; config(); break;
        case op >= 0x50 && op <= 0x5f: s.scenes[op & 0x0f] = NO_VALUE; config(); break;
        case op >= 0x60 && op <= 0x6f: s.groups |= 1 << (op & 0x0f); config(); break;
        case op >= 0x70 && op <= 0x7f: s.groups &= ~(1 << (op & 0x0f)); config(); break;
        case op === 0x80: // STORE DTR AS SHORT ADDRESS
          if (dtr0 === NO_VALUE) s.shortAddress = null;
          else if ((dtr0 & 0x81) === 0x01) s.shortAddress = (dtr0 >> 1) & 0x3f;
          config(); break;
        case op === 0x81: s.writeEnabled = true; break;
        default: return undefined; // reserved
      }
      this.changed();
      return undefined;
    }

    // --- queries (0x90-0xC5)
    switch (true) {
      case op === 0x90: return this.statusByte();
      case op === 0x91: return YES;
      case op === 0x92: return yesIf(s.faults.lampFailure);
      case op === 0x93: return yesIf(this.lampOn);
      case op === 0x94: return yesIf(s.limitError);
      case op === 0x95: return yesIf(s.resetState);
      case op === 0x96: return yesIf(s.shortAddress === null);
      case op === 0x97: return s.version;
      case op === 0x98: return s.dtr0;
      case op === 0x99: return this.deviceTypeAnswer();
      case op === 0x9a: return s.physicalMin;
      case op === 0x9b: return yesIf(s.powerFailure);
      case op === 0x9c: return s.dtr1;
      case op === 0x9d: return s.dtr2;
      case op === 0x9e: return s.operatingMode;
      case op === 0x9f: return NO_VALUE; // light source type: none declared
      case op === 0xa0: return s.actualLevel;
      case op === 0xa1: return s.maxLevel;
      case op === 0xa2: return s.minLevel;
      case op === 0xa3: return s.powerOnLevel;
      case op === 0xa4: return s.systemFailureLevel;
      case op === 0xa5: return (s.fadeTime << 4) | s.fadeRate;
      case op === 0xa6: return undefined; // manufacturer specific mode: not supported
      case op === 0xa7: return this.nextDeviceTypeAnswer();
      case op === 0xa8: return s.extendedFadeTime;
      case op >= 0xb0 && op <= 0xbf: return s.scenes[op & 0x0f];
      case op === 0xc0: return s.groups & 0xff;
      case op === 0xc1: return (s.groups >> 8) & 0xff;
      case op === 0xc2: return (s.randomAddress >> 16) & 0xff;
      case op === 0xc3: return (s.randomAddress >> 8) & 0xff;
      case op === 0xc4: return s.randomAddress & 0xff;
      case op === 0xc5: return this.readMemory();
      default: return undefined;
    }
  }

  /** Extension point for device-type specific commands (0xE0-0xFF after ENABLE DEVICE TYPE). */
  protected extended(_deviceType: number, _opcode: number): number | undefined {
    return undefined;
  }

  private reclamp(): void {
    const s = this.s;
    if (s.actualLevel > 0) {
      const l = Math.max(s.minLevel, Math.min(s.maxLevel, s.actualLevel));
      if (l !== s.actualLevel) { s.actualLevel = l; s.fade = null; }
    }
    s.targetLevel = s.fade ? s.fade.targetLevel : s.actualLevel;
  }

  private reset(): void {
    const s = this.s;
    applyResetValues(s);
    s.powerFailure = false;
    this.reclamp();
    this.changed();
  }

  private deviceTypeAnswer(): number {
    const n = this.s.deviceTypes.length;
    if (n === 0) return NO_VALUE;
    if (n === 1) return this.s.deviceTypes[0]!;
    this.s.nextDeviceTypeIndex = 0;
    return 254; // multiple types: iterate with QUERY NEXT DEVICE TYPE
  }

  private nextDeviceTypeAnswer(): number | undefined {
    const s = this.s;
    if (s.deviceTypes.length <= 1) return undefined;
    const t = s.deviceTypes[s.nextDeviceTypeIndex];
    s.nextDeviceTypeIndex++;
    return t === undefined ? NO_VALUE : t; // 255 = no further device type
  }

  private readMemory(): number | undefined {
    const s = this.s;
    const bank = s.memory[s.dtr1];
    if (!bank || s.dtr0 > (bank[0] ?? 0)) return undefined;
    const v = bank[s.dtr0]!;
    if (s.dtr0 < 255) s.dtr0++;
    this.changed();
    return v;
  }

  private writeMemory(d: number, reply: boolean): number | undefined {
    const s = this.s;
    const bank = s.memory[s.dtr1];
    if (!s.writeEnabled || s.dtr1 === 0 || !bank || s.dtr0 < 2 || s.dtr0 > (bank[0] ?? 0)) return undefined;
    bank[s.dtr0] = d;
    if (s.dtr0 < 255) s.dtr0++;
    this.changed();
    return reply ? d : undefined;
  }

  // ---- special commands (address byte 0xA1-0xC9) -----------------------------------------

  private special(a: number, d: number, again: boolean, t: Times): number | undefined {
    const s = this.s;
    const def = lookupSpecial(a)?.def;
    if (!def) return undefined;
    if (def.sendTwice && !this.twice(a, d, again, t)) return undefined;

    const inInit = s.init !== 'disabled';
    switch (a) {
      case 0xa1: if (inInit) { s.init = 'disabled'; this.changed(); } return undefined; // TERMINATE
      case 0xa3: s.dtr0 = d; this.changed(); return undefined;
      case 0xa5: { // INITIALISE
        const hit = d === 0x00 || (d === 0xff && s.shortAddress === null) ||
          ((d & 0x81) === 0x01 && s.shortAddress === ((d >> 1) & 0x3f));
        if (hit) { s.init = 'enabled'; s.initDeadlineUs = t.simUs + INIT_TIMEOUT_US; this.changed(); }
        return undefined;
      }
      case 0xa7: // RANDOMISE
        if (inInit) { s.randomAddress = Math.floor(this.rng() * 0x1000000) & 0xffffff; this.changed(); }
        return undefined;
      case 0xa9: return s.init === 'enabled' && s.randomAddress <= s.searchAddress ? YES : undefined; // COMPARE
      case 0xab: if (inInit && this.selected) { s.init = 'withdrawn'; this.changed(); } return undefined; // WITHDRAW
      case 0xad: return undefined; // PING
      case 0xb1: if (inInit) { s.searchAddress = (s.searchAddress & 0x00ffff) | (d << 16); this.changed(); } return undefined;
      case 0xb3: if (inInit) { s.searchAddress = (s.searchAddress & 0xff00ff) | (d << 8); this.changed(); } return undefined;
      case 0xb5: if (inInit) { s.searchAddress = (s.searchAddress & 0xffff00) | d; this.changed(); } return undefined;
      case 0xb7: // PROGRAM SHORT ADDRESS
        if (inInit && this.selected) {
          if (d === 0xff) s.shortAddress = null;
          else if ((d & 0x81) === 0x01) s.shortAddress = (d >> 1) & 0x3f;
          s.resetState = false;
          this.changed();
        }
        return undefined;
      case 0xb9: // VERIFY SHORT ADDRESS
        return inInit && s.shortAddress !== null && d === ((s.shortAddress << 1) | 1) ? YES : undefined;
      case 0xbb: // QUERY SHORT ADDRESS
        return inInit && this.selected ? (s.shortAddress === null ? NO_VALUE : (s.shortAddress << 1) | 1) : undefined;
      case 0xbd: return undefined; // PHYSICAL SELECTION: no physical button to press
      case 0xc1: s.enableDeviceType = d; return undefined; // ENABLE DEVICE TYPE (cleared by the next frame)
      case 0xc3: s.dtr1 = d; this.changed(); return undefined;
      case 0xc5: s.dtr2 = d; this.changed(); return undefined;
      case 0xc7: return this.writeMemory(d, true);
      case 0xc9: return this.writeMemory(d, false);
      default: return undefined;
    }
  }
}
