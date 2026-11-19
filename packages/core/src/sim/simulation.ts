import { Gear, type Rng } from './gear.js';
import { SIM_STATE_FORMAT, SIM_STATE_VERSION, rebaseGearTimes, type SimStateFile } from './persist.js';
import type { GearConfig, GearState, SimReply, Times } from './types.js';

export interface SimulationOptions {
  /** Maximum number of gears (a DALI bus has 64 addresses; the spec allows 65 for tests). */
  maxGears?: number;
  rng?: Rng;
}

export interface GearInfo { id: number; state: GearState }

/** A set of simulated gears sharing one bus. */
export class Simulation {
  readonly maxGears: number;
  private gearList: Gear[] = [];
  private nextId = 0;
  private dirty = new Set<number>();
  private structural = false;
  private readonly rng: Rng;

  constructor(opts: SimulationOptions = {}) {
    this.maxGears = opts.maxGears ?? 65;
    this.rng = opts.rng ?? Math.random;
  }

  get gears(): readonly Gear[] { return this.gearList; }
  gear(id: number): Gear | undefined { return this.gearList.find((g) => g.id === id); }

  addGear(cfg: GearConfig = {}): Gear {
    if (this.gearList.length >= this.maxGears) throw new Error(`At most ${this.maxGears} gears are supported`);
    const g = new Gear(this.nextId++, cfg, this.rng);
    g.onChange = () => this.dirty.add(g.id);
    this.gearList.push(g);
    this.structural = true;
    return g;
  }

  /** Add `n` gears; with `firstAddress` they get consecutive short addresses (skipping none). */
  addGears(n: number, cfg: GearConfig = {}, firstAddress?: number): Gear[] {
    const out: Gear[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.addGear({
        ...cfg,
        shortAddress: firstAddress === undefined ? cfg.shortAddress : firstAddress + i
      }));
    }
    return out;
  }

  removeGear(id: number): boolean {
    const i = this.gearList.findIndex((g) => g.id === id);
    if (i < 0) return false;
    this.gearList.splice(i, 1);
    this.dirty.delete(id);
    this.structural = true;
    return true;
  }

  clear(): void {
    this.gearList = [];
    this.dirty.clear();
    this.structural = true;
  }

  /** Feed one forward frame to every gear and combine the answers on the shared bus. */
  process(data: Uint8Array, bits: number, t: Times): SimReply {
    const answers: number[] = [];
    for (const g of this.gearList) {
      const a = g.process(data, bits, t);
      if (a !== undefined) answers.push(a);
    }
    if (answers.length === 0) return { kind: 'none' };
    // DALI answers superpose on the wire: identical bytes form a valid frame, different ones collide
    return answers.every((x) => x === answers[0])
      ? { kind: 'answer', byte: answers[0]! }
      : { kind: 'collision' };
  }

  /** Advance every gear to `simUs`. Returns true if anything animated. */
  advance(simUs: number): boolean {
    let any = false;
    for (const g of this.gearList) if (g.advance(simUs)) any = true;
    return any;
  }

  /** True while any gear is fading (the host should keep ticking). */
  get animating(): boolean { return this.gearList.some((g) => g.s.fade !== null); }

  /** Ids of gears that changed since the last call, and whether gears were added/removed. */
  consumeChanges(): { ids: number[]; structural: boolean } {
    const r = { ids: [...this.dirty], structural: this.structural };
    this.dirty.clear();
    this.structural = false;
    return r;
  }

  snapshot(): GearInfo[] {
    return this.gearList.map((g) => ({ id: g.id, state: g.snapshot() }));
  }

  /** Capture every gear's complete state. `simNowUs` is the simulation clock at this moment. */
  exportState(simNowUs: number, name?: string): SimStateFile {
    return {
      format: SIM_STATE_FORMAT, version: SIM_STATE_VERSION, savedAt: new Date().toISOString(), name,
      simNowUs, nextId: this.nextId,
      gears: this.gearList.map((g) => ({ id: g.id, state: g.snapshot() }))
    };
  }

  /**
   * Replace all gears with a saved state (already parsed by `parseSimState`). Running fades and timers
   * continue from where they were, measured on the clock that now reads `simNowUs`. Throws, leaving the
   * current gears untouched, when the state does not fit.
   */
  importState(file: SimStateFile, simNowUs: number): void {
    if (file.gears.length > this.maxGears) throw new Error(`The state has ${file.gears.length} gears, at most ${this.maxGears} fit`);
    const delta = simNowUs - file.simNowUs;
    const gears = file.gears.map(({ id, state }) => {
      const s = structuredClone(state);
      rebaseGearTimes(s, delta);
      const g = new Gear(id, { deviceTypes: s.deviceTypes, colour: s.dt8?.cfg }, this.rng);
      Object.assign(g.s, s);
      g.onChange = () => this.dirty.add(g.id);
      return g;
    });
    this.gearList = gears;
    this.nextId = Math.max(file.nextId, ...gears.map((g) => g.id + 1), 0);
    this.dirty.clear();
    this.structural = true;
  }
}
