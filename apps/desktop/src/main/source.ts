import type { BrowserWindow } from 'electron';
import { parseHexInput, type BusFrame } from '@dali-scout/core';
import { ReplayTransport, type DaliTransport } from '@dali-scout/transports';
import { CH, type SendRequest, type SendResult, type SimCommand, type SimCommandResult, type SourceInfo, type SourceKind } from '../shared';
import { SimHost } from './sim-host';

/** Owns the single active frame source and forwards its frames to the renderer in batches. */
export class SourceManager {
  private current: DaliTransport | null = null;
  private currentKind: SourceKind | null = null;
  private replay: ReplayTransport | null = null;
  private sim: SimHost | null = null;
  private replaySpeed = 1;
  private unsub: (() => void)[] = [];
  private pending: BusFrame[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  private emitSource(s: SourceInfo): void {
    this.getWindow()?.webContents.send(CH.source, s);
  }

  private queue(f: BusFrame): void {
    this.pending.push(f);
    if (this.flushTimer) return;
    // never send one IPC message per frame
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = this.pending;
      this.pending = [];
      this.getWindow()?.webContents.send(CH.frames, batch);
    }, 16);
  }

  async stop(): Promise<void> {
    this.unsub.forEach((u) => u());
    this.unsub = [];
    const t = this.current;
    this.current = null;
    this.currentKind = null;
    this.replay = null;
    const sim = this.sim;
    this.sim = null;
    if (t) await t.close();
    sim?.dispose();
  }

  async stopAndReport(): Promise<void> {
    await this.stop();
    this.emitSource({ state: 'idle', label: '' });
  }

  /** Attach `t`, open it and report the state. Failures are reported to the UI, not thrown. */
  async attach(t: DaliTransport, label: string, kind: SourceKind, sim?: SimHost): Promise<void> {
    await this.stop();
    this.sim = sim ?? null;
    this.current = t;
    this.currentKind = kind;
    this.unsub.push(t.onFrame((f) => this.queue(f)));
    this.unsub.push(t.onStatus((status, err) => {
      if (t !== this.current) return;
      if (status === 'closed') this.emitSource({ state: 'finished', label, kind });
      else if (status === 'error') this.emitSource({ state: 'error', label, kind, error: err?.message });
    }));
    try {
      await t.open();
      if (t === this.current) this.emitSource({ state: 'running', label, kind, canSend: t.caps.canSend });
    } catch (e) {
      if (t === this.current) {
        this.current = null;
        this.emitSource({ state: 'error', label, kind, error: (e as Error).message });
      }
    }
  }

  async startReplay(frames: BusFrame[], label: string): Promise<void> {
    const r = new ReplayTransport(frames, { speed: this.replaySpeed });
    await this.attach(r, label, 'replay');
    this.replay = r;
  }

  /** Virtual bus with simulated gears and a controller console. */
  async startVirtual(): Promise<void> {
    await this.stop();
    const host = new SimHost((s) => this.getWindow()?.webContents.send(CH.simState, s));
    await host.start();
    await this.attach(host.console_, 'Virtual bus', 'virtual', host);
  }

  /** Real bus with the simulated gears attached; they answer through the device when it can reply. */
  async startLive(t: DaliTransport, label: string): Promise<void> {
    const host = new SimHost((s) => this.getWindow()?.webContents.send(CH.simState, s), t);
    await host.start();
    await this.attach(t, label, 'device', host);
  }

  async simCommand(cmd: SimCommand): Promise<SimCommandResult> {
    if (!this.sim) return { ok: false, error: 'The simulator is not running. Start the virtual bus or simulate on a device first.' };
    return this.sim.command(cmd);
  }

  setReplaySpeed(speed: number): void {
    this.replaySpeed = speed;
    this.replay?.setSpeed(speed);
  }

  async send(req: SendRequest): Promise<SendResult> {
    const t = this.current;
    if (!t || !t.caps.canSend) return { ok: false, error: 'The current source cannot send frames' };
    try {
      const data = parseHexInput(req.hex);
      await t.send({ data, sendTwice: req.sendTwice, expectReply: req.expectReply });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
