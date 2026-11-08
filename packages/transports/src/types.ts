import type { BusFrame } from '@dali-scout/core';

export interface TransportCaps {
  canSniff: boolean;
  canSend: boolean;
  /** Can transmit backward frames (needed to answer queries when simulating gear). */
  canReply: boolean;
  hasHwTimestamps: boolean;
}

export interface TxFrame {
  data: Uint8Array;
  /** Defaults to data.length * 8. */
  bits?: number;
  /** Send the frame twice (DALI configuration commands). */
  sendTwice?: boolean;
}

export type TransportStatus = 'closed' | 'opening' | 'open' | 'error';

export interface DaliTransport {
  readonly id: string;
  readonly label: string;
  readonly caps: TransportCaps;
  readonly status: TransportStatus;
  open(): Promise<void>;
  close(): Promise<void>;
  send(frame: TxFrame): Promise<void>;
  /** Only present when caps.canReply. */
  sendBackward?(byte: number, delayUs?: number): Promise<void>;
  /** Returns an unsubscribe function. */
  onFrame(cb: (f: BusFrame) => void): () => void;
  onStatus(cb: (s: TransportStatus, error?: Error) => void): () => void;
}
