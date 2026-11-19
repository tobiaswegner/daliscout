import {
  SimClock, Simulation, commissionBus, createGearState, parseSimState,
  type BusFrame, type CommissioningIo, type GearConfig, type SimStateFile
} from '@dali-scout/core';
import { Dali104Transport, VirtualBus, attachSimulation, createHostClock, type DaliTransport, type VirtualTransport } from '@dali-scout/transports';
import type { SavedStateInfo, SimCommand, SimCommandResult, SimState } from '../shared';
import type { SimPersistence } from './sim-store';

const TICK_MS = 50;
const DEFAULT_GEARS = 8;
/** At most one automatic save per this many ms, however often the state changes (fades change it constantly). */
const AUTOSAVE_MS = 2000;

/**
 * Runs the gear simulation on a virtual bus: owns the Simulation, its clock and the tick that
 * animates fades, and publishes snapshots whenever something changed.
 */
export class SimHost {
  readonly sim = new Simulation({ maxGears: 65 });
  readonly clock: SimClock;
  /** The bus and the controller-side endpoint ("console") that the monitor and send panel use. */
  readonly bus = new VirtualBus(undefined, { wireTiming: true });
  readonly console_: VirtualTransport = this.bus.createEndpoint('console');
  private readonly simEndpoint: VirtualTransport = this.bus.createEndpoint('sim', { canSend: false, canReply: true });
  /** Reply latency (query frame -> answer written), live mode only. */
  private latencies: number[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private detach?: () => void;
  private busy?: string;
  private lastReply: BusFrame | undefined;
  private forceEmit = true;
  private lastNet = '';
  private autoDirty = false;
  private lastAutoSave = 0;
  private saved: SavedStateInfo[] = [];
  private restored?: string;
  private restoreError?: string;

  /**
   * @param live  a real bus transport (already attached to the monitor by the caller); the gears
   *              then follow its traffic and answer through it. Without it the gears run on a virtual bus.
   * @param store distinguishes sessions: when given (and enabled) the last session's gears are restored
   *              and every change is saved again.
   */
  constructor(
    private readonly emit: (s: SimState) => void, private readonly live?: DaliTransport,
    private readonly store?: SimPersistence
  ) {
    this.clock = new SimClock(live ? createHostClock() : this.bus.now);
    let restored = false;
    if (store?.autoEnabled()) {
      try {
        const f = store.loadAuto();
        if (f) {
          this.sim.importState(f, this.clock.now());
          this.restored = `Restored ${f.gears.length} gear${f.gears.length === 1 ? '' : 's'} from the last session`;
          restored = true;
        }
      } catch (e) {
        this.restoreError = `The saved state could not be restored: ${(e as Error).message}`;
      }
    }
    if (!restored) this.sim.addGears(DEFAULT_GEARS, {}, 0);
    this.refreshSaved();
  }

  private refreshSaved(): void {
    try { this.saved = this.store?.list() ?? []; } catch { this.saved = []; }
  }

  /** Write the automatic save now if anything changed since the last one. */
  flush(): void {
    if (!this.autoDirty || !this.store?.autoEnabled()) return;
    this.autoDirty = false;
    this.lastAutoSave = Date.now();
    try { this.store.saveAuto(this.sim.exportState(this.clock.now())); }
    catch (e) { this.restoreError = `Saving the state failed: ${(e as Error).message}`; this.forceEmit = true; }
  }

  /** The current gears as a state file (for export). */
  exportState(): SimStateFile {
    return this.sim.exportState(this.clock.now());
  }

  /** Replace the gears with the state in `text` (an exported file). */
  importState(text: string): string {
    return this.applyState(parseSimState(text), 'file');
  }

  private applyState(f: SimStateFile, what: string): string {
    if (this.busy) throw new Error(`Busy: ${this.busy}`);
    this.sim.importState(f, this.clock.now());
    this.restored = undefined;
    this.restoreError = undefined;
    this.autoDirty = true;
    this.forceEmit = true;
    this.tick();
    return `Restored ${what} (${f.gears.length} gear${f.gears.length === 1 ? '' : 's'})`;
  }

  /** Open the gear endpoint and start animating. The console transport is opened by the caller. */
  async start(): Promise<void> {
    if (this.live) {
      const t = this.live;
      // measure how long answers take: query frame seen -> answer written
      let queryAt = 0;
      const offB = t.onFrame((f) => {
        if (f.kind === 'forward' && f.dir === 'rx') queryAt = performance.now();
        else if (f.kind === 'backward' && f.dir === 'tx' && queryAt) {
          this.latencies.push(performance.now() - queryAt);
          if (this.latencies.length > 50) this.latencies.shift();
          queryAt = 0;
          this.forceEmit = true;
        }
      });
      // attach after the latency listener so it sees the query before the answer goes out
      // DALI-over-IP delivers send-twice commands once; the gears need both copies
      const offA = attachSimulation(t, this.sim, { simTime: () => this.clock.now(), repeatSendTwice: t instanceof Dali104Transport });
      this.detach = () => { offA(); offB(); };
    } else {
      await this.simEndpoint.open();
      this.detach = attachSimulation(this.simEndpoint, this.sim, { simTime: () => this.clock.now() });
      // the console endpoint also sees the gears' answers; commissioning reads them from here
      this.console_.onFrame((f) => { if (f.kind !== 'forward') this.lastReply = f; });
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.publish();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
    this.detach?.();
    this.detach = undefined;
    this.emit({ active: false, gears: [], maxGears: this.sim.maxGears, speed: 1, paused: false });
  }

  private tick(): void {
    this.sim.advance(this.clock.now());
    const { ids, structural } = this.sim.consumeChanges();
    const net = JSON.stringify(this.netStats() ?? null);
    const netChanged = net !== this.lastNet;
    this.lastNet = net;
    if (ids.length || structural) this.autoDirty = true;
    if (this.autoDirty && Date.now() - this.lastAutoSave >= AUTOSAVE_MS) this.flush();
    if (ids.length || structural || this.forceEmit || netChanged) this.publish();
  }

  private publish(): void {
    this.forceEmit = false;
    this.emit({
      active: true, gears: this.sim.snapshot(), maxGears: this.sim.maxGears,
      speed: this.clock.speed, paused: this.clock.paused, busy: this.busy,
      persist: this.store
        ? { auto: this.store.autoEnabled(), saved: this.saved, restored: this.restored, error: this.restoreError }
        : undefined,
      live: this.live ? { canReply: this.live.caps.canReply, replyMs: this.replyStats(), net: this.netStats() } : undefined
    });
  }

  private netStats(): NonNullable<SimState['live']>['net'] {
    const t = this.live;
    if (!(t instanceof Dali104Transport)) return undefined;
    return {
      listen: t.label, received: t.received, answered: t.answered, ignored: t.ignored,
      lastIgnored: t.lastIgnoredHex, lastPeer: t.lastPeer
    };
  }

  private replyStats(): { n: number; avg: number; max: number } | undefined {
    const l = this.latencies;
    if (!l.length) return undefined;
    return { n: l.length, avg: l.reduce((a, b) => a + b, 0) / l.length, max: Math.max(...l) };
  }

  private setBusy(text: string | undefined): void {
    this.busy = text;
    this.forceEmit = true;
  }

  async command(cmd: SimCommand): Promise<SimCommandResult> {
    try {
      const msg = await this.run(cmd);
      this.tick();
      return { ok: true, message: msg };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async run(cmd: SimCommand): Promise<string | undefined> {
    const sim = this.sim;
    const gear = (id: number) => {
      const g = sim.gear(id);
      if (!g) throw new Error(`No gear with id ${id}`);
      return g;
    };
    switch (cmd.type) {
      case 'add': {
        const n = Math.max(1, Math.min(65, Math.floor(cmd.count)));
        if (sim.gears.length + n > sim.maxGears) throw new Error(`At most ${sim.maxGears} gears fit (have ${sim.gears.length})`);
        const gt = cmd.gearType ?? 'plain';
        const cfg: GearConfig = gt === 'plain' ? {} : gt === 'dt0' ? { deviceTypes: [0] } : { colour: gt };
        if (cmd.addressed) {
          // lowest free short addresses; the rest stay unaddressed
          const used = new Set(sim.gears.map((g) => g.s.shortAddress));
          for (let i = 0; i < n; i++) {
            let a = 0;
            while (used.has(a) && a < 64) a++;
            if (a < 64) used.add(a);
            sim.addGear({ ...cfg, shortAddress: a < 64 ? a : null });
          }
        } else sim.addGears(n, cfg);
        return undefined;
      }
      case 'remove': if (!sim.removeGear(cmd.id)) throw new Error(`No gear with id ${cmd.id}`); return undefined;
      case 'clone': {
        const src = gear(cmd.id).s;
        const g = sim.addGear({ name: `${src.name} copy`, physicalMin: src.physicalMin, deviceTypes: src.deviceTypes, version: src.version, colour: src.dt8?.cfg });
        // an independent unaddressed copy of the configuration (a duplicate short address would clash on a real bus)
        const keep = createGearState(g.id, { name: g.s.name });
        Object.assign(g.s, structuredClone({ ...src, name: keep.name, shortAddress: null, memory: keep.memory }));
        return undefined;
      }
      case 'clear': sim.clear(); return undefined;
      case 'scenario': {
        // 65 mixed gear: 64 addressed, the 65th stays unaddressed
        sim.clear();
        const mix: [number, GearConfig][] = [
          [20, { colour: 'rgb-ct' }], [10, { colour: 'rgbw' }], [10, { colour: 'rgb' }], [5, { colour: 'tc' }],
          [10, { deviceTypes: [0] }], [10, {}]
        ];
        let n = 0;
        for (const [count, cfg] of mix) for (let i = 0; i < count; i++, n++) sim.addGear({ ...cfg, shortAddress: n < 64 ? n : null });
        return 'Added 65 gears: 20 RGB+CT, 10 RGBW, 10 RGB, 5 CT, 10 DT0, 10 plain';
      }
      case 'rename': gear(cmd.id).s.name = cmd.name.slice(0, 40); gear(cmd.id).onChange?.(); return undefined;
      case 'setLevel': gear(cmd.id).forceLevel(cmd.level); return undefined;
      case 'fault': gear(cmd.id).setFault(cmd.patch); return undefined;
      case 'powerCycle': gear(cmd.id).powerCycle(); return undefined;
      case 'speed': this.clock.setSpeed(cmd.value); this.forceEmit = true; return undefined;
      case 'pause': if (cmd.value) this.clock.pause(); else this.clock.resume(); this.forceEmit = true; return undefined;
      case 'saveState': {
        const store = this.store;
        if (!store) throw new Error('Saving is not available');
        const n = store.save(cmd.name, this.sim.exportState(this.clock.now(), cmd.name));
        this.refreshSaved();
        this.forceEmit = true;
        return `Saved state "${n}" (${sim.gears.length} gear${sim.gears.length === 1 ? '' : 's'})`;
      }
      case 'restoreState': {
        if (!this.store) throw new Error('Saving is not available');
        return this.applyState(this.store.load(cmd.name), `"${cmd.name}"`);
      }
      case 'deleteState': {
        if (!this.store) throw new Error('Saving is not available');
        this.store.remove(cmd.name);
        this.refreshSaved();
        this.forceEmit = true;
        return undefined;
      }
      case 'autoState': {
        if (!this.store) throw new Error('Saving is not available');
        this.store.setAuto(cmd.value);
        if (cmd.value) this.autoDirty = true;
        this.forceEmit = true;
        return cmd.value ? 'The state is saved automatically and restored at start' : 'The state is no longer remembered between sessions';
      }
      case 'commission': {
        if (this.live) throw new Error('Commissioning is done by the controller on a live bus');
        if (this.busy) throw new Error(`Busy: ${this.busy}`);
        this.setBusy('Commissioning…');
        this.publish();
        try {
          const res = await commissionBus(this.io(), { all: cmd.all });
          return `Commissioned ${res.assigned} gear${res.assigned === 1 ? '' : 's'} with ${res.frames} frames`;
        } finally {
          this.setBusy(undefined);
        }
      }
    }
  }

  /** Controller I/O over the real (virtual) bus, so the monitor shows the whole conversation. */
  private io(): CommissioningIo {
    let sent = 0;
    const yieldSometimes = async () => {
      if (++sent % 100 === 0) await new Promise<void>((r) => setImmediate(r)); // let timers and IPC run
    };
    return {
      send: async (f, twice) => {
        await this.console_.send({ data: Uint8Array.from(f), sendTwice: twice });
        await yieldSometimes();
      },
      query: async (f) => {
        this.lastReply = undefined;
        await this.console_.send({ data: Uint8Array.from(f), expectReply: true });
        await yieldSometimes();
        const r = this.lastReply as BusFrame | undefined; // set by the console listener during send()
        if (!r) return null;
        return r.kind === 'error' ? 255 : r.data[0]!;   // a collision still proves somebody answered
      }
    };
  }
}
