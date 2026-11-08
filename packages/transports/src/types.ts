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
  /** The frame is a query: ask the interface to wait for a backward frame. */
  expectReply?: boolean;
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

/** Byte/packet pipe to a physical device (serial port, HID). Supplied by the host app. */
export interface DeviceStream {
  write(data: Uint8Array): Promise<void>;
  onData(cb: (data: Uint8Array) => void): () => void;
  /** Called when the device disappears or errors out. */
  onClose(cb: (err?: Error) => void): () => void;
  close(): Promise<void>;
}

/** Opens the underlying device; called by the transport's open(). */
export type StreamFactory = () => Promise<DeviceStream>;
