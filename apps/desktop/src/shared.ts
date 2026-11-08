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
}

export interface SourceInfo {
  state: 'idle' | 'running' | 'finished' | 'error';
  label: string;
  error?: string;
}

export const CH = {
  frames: 'frames',
  source: 'source',
  openCapture: 'capture:open',
  startDemo: 'demo:start',
  stop: 'source:stop',
  speed: 'replay:speed'
} as const;
