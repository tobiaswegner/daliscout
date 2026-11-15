import { Decoder, type Simulation } from '@dali-scout/core';
import type { DaliTransport } from './types.js';

export interface AttachOptions {
  /** Current simulation time in µs (see SimClock). */
  simTime: () => number;
  /** Delay of backward frames after the query; default is the transport's. */
  replyDelayUs?: number;
  /**
   * The transport delivers send-twice commands (INITIALISE, RANDOMISE, configuration commands …) only once,
   * as DALI-over-IP does (IEC 62386-104 9.4: received once, executed; sent once per operation): the
   * telecommunication unit repeats them on the bus. The gears then get the second
   * copy from here, which is not shown in the monitor.
   */
  repeatSendTwice?: boolean;
}

/** Bus time between the two copies of a send-twice command (a 16-bit frame plus the guard time), µs. */
const TWICE_GAP_US = 25_000;

type ReplyCapable = DaliTransport & { sendCollision?: (delayUs?: number) => Promise<void> };

/**
 * Connect a gear Simulation to a bus transport: every forward frame seen is fed to the gears,
 * and answers go back out as backward frames. On a transport that cannot transmit backward
 * frames (caps.canReply === false, e.g. the USB interfaces) the gears still follow the traffic
 * but stay silent. Returns a function that detaches.
 */
export function attachSimulation(transport: ReplyCapable, sim: Simulation, opts: AttachOptions): () => void {
  const decoder = opts.repeatSendTwice ? new Decoder() : undefined;
  return transport.onFrame((f) => {
    if (f.kind !== 'forward') return;
    let reply = sim.process(f.data, f.bits, { busUs: f.ts, simUs: opts.simTime() });
    if (decoder && decoder.decode(f).sendTwice) {
      reply = sim.process(f.data, f.bits, { busUs: f.ts + TWICE_GAP_US, simUs: opts.simTime() });
    }
    if (!transport.caps.canReply || reply.kind === 'none') return;
    if (reply.kind === 'answer') void transport.sendBackward?.(reply.byte, opts.replyDelayUs);
    else void transport.sendCollision?.(opts.replyDelayUs);
  });
}
