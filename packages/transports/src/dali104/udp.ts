import { createSocket } from 'node:dgram';

export interface UdpPeer { address: string; port: number }

/** Minimal datagram socket, so the transport can be tested without the network. */
export interface UdpEndpoint {
  /** Bind to a local port (0 = ephemeral). Resolves with the port actually bound. */
  bind(port: number, host?: string): Promise<number>;
  send(data: Uint8Array, peer: UdpPeer): Promise<void>;
  onMessage(cb: (data: Uint8Array, from: UdpPeer) => void): () => void;
  /** Socket error or close. */
  onError(cb: (err: Error) => void): () => void;
  close(): Promise<void>;
}

export type UdpFactory = () => UdpEndpoint;

/** UDP over node:dgram. */
export const nodeUdp: UdpFactory = () => {
  const sock = createSocket({ type: 'udp4', reuseAddr: true });
  const msg = new Set<(d: Uint8Array, f: UdpPeer) => void>();
  const err = new Set<(e: Error) => void>();
  sock.on('message', (buf, rinfo) => msg.forEach((cb) => cb(new Uint8Array(buf), { address: rinfo.address, port: rinfo.port })));
  sock.on('error', (e) => err.forEach((cb) => cb(e)));
  return {
    bind: (port, host) => new Promise<number>((resolve, reject) => {
      const fail = (e: Error) => reject(e);
      sock.once('error', fail);
      sock.bind(port, host, () => { sock.off('error', fail); resolve(sock.address().port); });
    }),
    send: (data, peer) => new Promise<void>((resolve, reject) =>
      sock.send(data, peer.port, peer.address, (e) => (e ? reject(e) : resolve()))),
    onMessage: (cb) => { msg.add(cb); return () => msg.delete(cb); },
    onError: (cb) => { err.add(cb); return () => err.delete(cb); },
    close: () => new Promise<void>((resolve) => { try { sock.close(() => resolve()); } catch { resolve(); } })
  };
};
