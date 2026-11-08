import type { Simulation } from '@dali-scout/core';
import type { DaliTransport } from './types.js';

export interface AttachOptions {
  /** Current simulation time in µs (see SimClock). */
  simTime: () => number;
  /** Delay of backward frames after the query; default is the transport's. */
  replyDelayUs?: number;
}

type ReplyCapable = DaliTransport & { sendCollision?: (delayUs?: number) => Promise<void> };

/**
 * Connect a gear Simulation to a bus transport: every forward frame seen is fed to the gears,
 * and answers go back out as backward frames. On a transport that cannot transmit backward
 * frames (caps.canReply === false, e.g. the USB interfaces) the gears still follow the traffic
 * but stay silent. Returns a function that detaches.
 */
export function attachSimulation(transport: ReplyCapable, sim: Simulation, opts: AttachOptions): () => void {
  return transport.onFrame((f) => {
    if (f.kind !== 'forward') return;
    const reply = sim.process(f.data, f.bits, { busUs: f.ts, simUs: opts.simTime() });
    if (!transport.caps.canReply || reply.kind === 'none') return;
    if (reply.kind === 'answer') void transport.sendBackward?.(reply.byte, opts.replyDelayUs);
    else void transport.sendCollision?.(opts.replyDelayUs);
  });
}
