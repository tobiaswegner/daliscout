import type { BusFrame, GearFaults, GearState } from '@dali-scout/core';

/** IPC contract between main and renderer. */
export interface DaliApi {
  /** Subscribe to batches of frames (flushed at most every ~16 ms). */
  onFrames(cb: (frames: BusFrame[]) => void): () => void;
  onSource(cb: (s: SourceInfo) => void): () => void;
  /** Show an open dialog and replay the chosen .dscap file. */
  openCapture(): Promise<void>;
  startDemo(): Promise<void>;
  stop(): Promise<void>;
  setReplaySpeed(speed: number): Promise<void>;
  listDevices(): Promise<DeviceList>;
  connect(target: ConnectTarget): Promise<void>;
  send(req: SendRequest): Promise<SendResult>;
  saveFile(req: SaveRequest): Promise<{ saved: boolean; path?: string }>;
  /** Subscribe to simulator snapshots (pushed when something changed, at most ~20 per second). */
  onSimState(cb: (s: SimState) => void): () => void;
  simCommand(cmd: SimCommand): Promise<SimCommandResult>;
}

/** What kind of gear to add: plain, DT0 lamp, or a DT8 colour preset. */
export type GearType = 'plain' | 'dt0' | 'rgb' | 'rgbw' | 'rgb-ct' | 'tc' | 'xy';

export interface SimGearView { id: number; state: GearState }

export interface SimState {
  /** False while no virtual bus is running. */
  active: boolean;
  gears: SimGearView[];
  maxGears: number;
  speed: number;
  paused: boolean;
  /** Set while a long operation such as commissioning runs. */
  busy?: string;
  /** Present when the gears are attached to a real bus instead of the virtual one. */
  live?: { canReply: boolean; replyMs?: { n: number; avg: number; max: number } };
}

export type SimCommand =
  | { type: 'add'; count: number; addressed: boolean; gearType?: GearType }
  | { type: 'remove'; id: number }
  | { type: 'clone'; id: number }
  | { type: 'clear' }
  | { type: 'rename'; id: number; name: string }
  | { type: 'setLevel'; id: number; level: number }
  | { type: 'fault'; id: number; patch: Partial<GearFaults> }
  | { type: 'powerCycle'; id: number }
  | { type: 'speed'; value: number }
  | { type: 'pause'; value: boolean }
  | { type: 'commission'; all: boolean }
  | { type: 'scenario'; name: 'mixed65' };

export type SimCommandResult = { ok: true; message?: string } | { ok: false; error: string };

export type SourceKind = 'replay' | 'virtual' | 'device';

export interface SourceInfo {
  state: 'idle' | 'running' | 'finished' | 'error';
  label: string;
  kind?: SourceKind;
  /** The source can transmit frames (send panel enabled). */
  canSend?: boolean;
  error?: string;
}

export type DeviceKind = 'dali-usb-hid' | 'dali2-usb-serial' | 'serial';

export interface DeviceInfo {
  /** `hid:<path>` or `serial:<path>`. */
  id: string;
  kind: DeviceKind;
  label: string;
  detail?: string;
}

export interface DeviceList {
  devices: DeviceInfo[];
  /** Problems that prevented some discovery (e.g. native module could not load). */
  warnings: string[];
}

export type ConnectTarget = { kind: 'virtual' } | { kind: 'device'; id: string; /** also run the gear simulator on this bus */ simulate?: boolean };

export interface SendRequest { hex: string; sendTwice: boolean; expectReply: boolean }
export type SendResult = { ok: true } | { ok: false; error: string };

export interface SaveRequest {
  defaultName: string;
  filters: { name: string; extensions: string[] }[];
  content: string;
}

export const CH = {
  frames: 'frames',
  source: 'source',
  openCapture: 'capture:open',
  startDemo: 'demo:start',
  stop: 'source:stop',
  speed: 'replay:speed',
  devices: 'devices:list',
  connect: 'source:connect',
  send: 'tx:send',
  saveFile: 'file:save',
  simState: 'sim:state',
  simCommand: 'sim:cmd'
} as const;
