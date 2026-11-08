import type { BusFrame } from '@dali-scout/core';

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
}

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

export type ConnectTarget = { kind: 'virtual' } | { kind: 'device'; id: string };

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
  saveFile: 'file:save'
} as const;
