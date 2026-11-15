import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Simulation, toHex, type BusFrame } from '@dali-scout/core';
import {
  Dali104Transport, attachSimulation, decodePacket, encodeBackward, encodeForward,
  type UdpEndpoint, type UdpPeer
} from '../src/index.js';

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join(' ');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (f: BusFrame) => `${f.dir} ${f.bits} ${toHex(f.data, '')}`;

describe('DALI-over-IP codec', () => {
  it('encodes backward packets byte-identical to an independent implementation', () => {
    // bytes produced by an example DALI-over-IP peer (backward(seq, sysaddr, has_dt, dt, address, opcode, answer))
    expect(hex(encodeBackward(0x1234, 0, { address: 0x03, opcode: 0xf7, deviceType: 8 }, 0x2a)))
      .toBe('da 88 00 12 34 00 00 07 01 00 80 08 03 f7 2a');
    expect(hex(encodeBackward(1, 5, { address: 0x03, opcode: 0x90 }, 0xff)))
      .toBe('da 88 00 00 01 05 00 06 01 00 00 03 90 ff');
  });
  it('round-trips forward and backward packets', () => {
    const f = encodeForward(0xabcd, 3, { address: 0xfe, opcode: 0x90 });
    expect(hex(f)).toBe('da 08 00 ab cd 03 00 05 01 00 00 fe 90');
    expect(decodePacket(f)).toEqual({ type: 'forward', seq: 0xabcd, systemAddress: 3, frame: { address: 0xfe, opcode: 0x90 }, answer: undefined });
    const b = decodePacket(encodeBackward(7, 0, { address: 1, opcode: 0xa0, deviceType: 8 }, 0x55))!;
    expect(b).toMatchObject({ type: 'backward', seq: 7, answer: 0x55, frame: { address: 1, opcode: 0xa0, deviceType: 8 } });
  });
  it('rejects what it does not understand', () => {
    const ok = encodeForward(1, 0, { address: 1, opcode: 2 });
    expect(decodePacket(ok.subarray(0, 7))).toBeUndefined();            // too short
    expect(decodePacket(ok.subarray(0, 11))).toBeUndefined();           // shorter than its length field
    expect(decodePacket(Uint8Array.from([0x00, ...ok.subarray(1)]))).toBeUndefined(); // bad start byte
    const dtls = ok.slice(); dtls[2] = 0x80;
    expect(decodePacket(dtls)).toBeUndefined();
    const odd = ok.slice(); odd[1] = 0x48;
    expect(decodePacket(odd)).toBeUndefined();
  });
});

// ---- in-memory UDP ---------------------------------------------------------------------------

class Net {
  nodes = new Map<number, FakeUdp>();
  nextPort = 50000;
}
class FakeUdp implements UdpEndpoint {
  port = 0;
  private msg: ((d: Uint8Array, f: UdpPeer) => void)[] = [];
  private err: ((e: Error) => void)[] = [];
  closed = false;
  sent: Uint8Array[] = [];
  constructor(private net: Net) {}
  async bind(port: number) {
    this.port = port || this.net.nextPort++;
    if (this.net.nodes.has(this.port)) throw new Error('EADDRINUSE');
    this.net.nodes.set(this.port, this);
    return this.port;
  }
  async send(data: Uint8Array, peer: UdpPeer) {
    this.sent.push(data);
    const dst = this.net.nodes.get(peer.port);
    queueMicrotask(() => dst?.msg.forEach((cb) => cb(data.slice(), { address: '127.0.0.1', port: this.port })));
  }
  onMessage(cb: (d: Uint8Array, f: UdpPeer) => void) { this.msg.push(cb); return () => { this.msg = this.msg.filter((x) => x !== cb); }; }
  onError(cb: (e: Error) => void) { this.err.push(cb); return () => { this.err = this.err.filter((x) => x !== cb); }; }
  fail(e: Error) { this.err.forEach((cb) => cb(e)); }
  async close() { this.closed = true; if (this.net.nodes.get(this.port) === this) this.net.nodes.delete(this.port); }
}

const pair = async () => {
  const net = new Net();
  const eps: FakeUdp[] = [];
  const udp = () => { const e = new FakeUdp(net); eps.push(e); return e; };
  const server = new Dali104Transport({ role: 'server', port: 62386, udp, id: 'srv' });
  const sFrames: BusFrame[] = [];
  server.onFrame((f) => sFrames.push(f));
  await server.open();
  const client = new Dali104Transport({ role: 'client', host: '127.0.0.1', port: 62386, udp, id: 'cli' });
  const cFrames: BusFrame[] = [];
  client.onFrame((f) => cFrames.push(f));
  await client.open();
  return { net, eps, server, client, sFrames, cFrames };
};

describe('Dali104Transport (loopback)', () => {
  it('has the right capabilities per role', async () => {
    const { server, client } = await pair();
    expect(server.caps).toMatchObject({ canSend: false, canReply: true, canSniff: true });
    expect(client.caps).toMatchObject({ canSend: true, canReply: false });
    expect(() => new Dali104Transport({ role: 'client' })).toThrow(/host/);
    await server.close(); await client.close();
  });

  it('a client query reaches the server and the gear answer comes back', async () => {
    const { server, client, sFrames, cFrames } = await pair();
    const sim = new Simulation();
    sim.addGear({ shortAddress: 4 });
    attachSimulation(server, sim, { simTime: () => 0 });
    await client.send({ data: Uint8Array.of(0x09, 0xa0) }); // QUERY ACTUAL LEVEL, short address 4
    await wait(5);
    const answer = toHex(sFrames[1]!.data, '');
    expect(sFrames.map(show)).toEqual(['rx 16 09A0', `tx 8 ${answer}`]);
    expect(cFrames.map(show)).toEqual(['tx 16 09A0', `rx 8 ${answer}`]);
    await server.close(); await client.close();
  });

  it('folds ENABLE DEVICE TYPE into the device type of the next packet and back', async () => {
    const { server, client, sFrames, eps } = await pair();
    await client.send({ data: Uint8Array.of(0xc1, 0x08) });
    expect(eps.at(-1)!.sent).toHaveLength(0);          // nothing on the wire yet
    await client.send({ data: Uint8Array.of(0x01, 0xf7) });
    await wait(5);
    expect(hex(eps.at(-1)!.sent[0]!)).toMatch(/^da 08 00 .. .. 00 00 06 01 00 80 08 01 f7$/);
    expect(sFrames.map(show)).toEqual(['rx 16 C108', 'rx 16 01F7']);
    await server.close(); await client.close();
  });

  it('answers only the latest query, once', async () => {
    const { server, client, sFrames } = await pair();
    await client.send({ data: Uint8Array.of(0x01, 0x90) });
    await wait(5);
    await server.sendBackward!(0x11);
    await server.sendBackward!(0x22);                  // nothing pending any more
    expect(sFrames.filter((f) => f.dir === 'tx').map(show)).toEqual(['tx 8 11']);
    await server.close(); await client.close();
  });

  it('refuses frames it cannot carry and ignores garbage', async () => {
    const { server, client, net, eps } = await pair();
    await expect(client.send({ data: Uint8Array.of(1, 2, 3) })).rejects.toThrow(RangeError);
    await expect(client.send({ data: Uint8Array.of(1), bits: 8 })).rejects.toThrow(RangeError);
    await expect(server.send({ data: Uint8Array.of(1, 2) })).rejects.toThrow(/server/);
    await eps[1]!.send(Uint8Array.of(1, 2, 3), { address: '127.0.0.1', port: 62386 });
    await wait(5);
    expect(server.ignored).toBe(1);
    expect(net.nodes.size).toBe(2);
    await server.close(); await client.close();
  });

  it('reports a failed first open, then reconnects with backoff after a later socket error', async () => {
    const net = new Net();
    const udp = () => new FakeUdp(net);
    const a = new Dali104Transport({ role: 'server', port: 62386, udp });
    const b = new Dali104Transport({ role: 'server', port: 62386, udp });
    await a.open();
    await expect(b.open()).rejects.toThrow(/EADDRINUSE/);   // port already taken
    expect(b.status).toBe('error');

    const statuses: string[] = [];
    a.onStatus((s) => statuses.push(s));
    [...net.nodes.values()][0]!.fail(new Error('network down'));
    await wait(10);
    expect(statuses).toContain('error');
    await wait(1100);                                       // first retry after 1 s
    expect(a.status).toBe('open');
    await a.close();
  }, 5000);
});

describe('send-twice commands over DALI-over-IP', () => {
  it('RANDOMISE sent once (as the gateway driver does) still re-randomises the gear', async () => {
    const { server, client, cFrames } = await pair();
    const sim = new Simulation({ rng: () => 0.25 });
    sim.addGear({ shortAddress: 0 });
    attachSimulation(server, sim, { simTime: () => 0, repeatSendTwice: true });
    await client.send({ data: Uint8Array.of(0xa5, 0x01) });   // INITIALISE short address 0 (once)
    await client.send({ data: Uint8Array.of(0xa7, 0x00) });   // RANDOMISE (once)
    await client.send({ data: Uint8Array.of(0x01, 0xc2) });   // QUERY RANDOM ADDRESS (H)
    await wait(20);
    expect(cFrames.filter((f) => f.dir === 'rx').map(show)).toEqual(['rx 8 40']); // 0.25 * 2^24 >> 16 = 0x40
    expect(cFrames.filter((f) => f.dir === 'tx')).toHaveLength(3);               // the monitor sees each command once
    await server.close(); await client.close();
  });
  it('without the repeat the gear would ignore the single copy', async () => {
    const { server, client, cFrames } = await pair();
    const sim = new Simulation({ rng: () => 0.25 });
    sim.addGear({ shortAddress: 0 });
    attachSimulation(server, sim, { simTime: () => 0 });
    await client.send({ data: Uint8Array.of(0xa5, 0x01) });
    await client.send({ data: Uint8Array.of(0xa7, 0x00) });
    await client.send({ data: Uint8Array.of(0x01, 0xc2) });
    await wait(20);
    expect(cFrames.filter((f) => f.dir === 'rx').map(show)).toEqual(['rx 8 FF']);
    await server.close(); await client.close();
  });
});

describe('Dali104Transport (real UDP on 127.0.0.1)', () => {
  it('a client and a gear-simulating server talk over real sockets', async () => {
    const server = new Dali104Transport({ role: 'server', port: 0, bindHost: '127.0.0.1' });
    await server.open();
    expect(server.localPort).toBeGreaterThan(0);
    const sim = new Simulation();
    sim.addGear({ shortAddress: 2 });
    attachSimulation(server, sim, { simTime: () => 0 });
    const client = new Dali104Transport({ role: 'client', host: '127.0.0.1', port: server.localPort });
    const frames: BusFrame[] = [];
    client.onFrame((f) => frames.push(f));
    await client.open();
    await client.send({ data: Uint8Array.of(0x05, 0xa0) });            // QUERY ACTUAL LEVEL, short address 2
    await wait(100);
    expect(frames.map((f) => f.dir + f.bits)).toEqual(['tx16', 'rx8']);
    await client.close(); await server.close();
  });
});

// ---- interop with an external peer -----------------------------------------------------------

// An external DALI-over-IP peer script is not part of the repository: set DALI104_PEER to run these tests.
const peerScript = process.env.DALI104_PEER ? resolve(process.env.DALI104_PEER) : '';
const havePython = spawnSync('python3', ['--version']).status === 0 && !!peerScript && existsSync(peerScript);

describe.skipIf(!havePython)('interop with an external peer (DALI104_PEER)', () => {
  let child: ChildProcess | undefined;
  afterEach(() => { child?.kill(); child = undefined; });

  const start = async (port: number, extra: string[] = []) => {
    child = spawn('python3', ['-B', '-I', peerScript, '--port', String(port), '--gears', '4', '--types', 'dt0,rgb', ...extra], { stdio: 'ignore' });
    await wait(500);
  };

  it('queries gears of the Python simulator and sees their answers', async () => {
    const port = 40000 + Math.floor(Math.random() * 10000);
    await start(port);
    const t = new Dali104Transport({ role: 'client', host: '127.0.0.1', port });
    const frames: BusFrame[] = [];
    t.onFrame((f) => frames.push(f));
    await t.open();
    await t.send({ data: Uint8Array.of(0x01, 0xa0) });            // QUERY ACTUAL LEVEL, short address 0
    await t.send({ data: Uint8Array.of(0x03, 0x90) });            // QUERY STATUS, address 1
    await t.send({ data: Uint8Array.of(0x01, 0x98) });            // QUERY DEVICE TYPE, address 0
    await wait(300);
    const backs = frames.filter((f) => f.kind === 'backward' && f.dir === 'rx');
    expect(backs.length).toBe(3);
    expect(backs[2]!.data[0]).toBe(0x00);                         // gear 0 is device type 0
    await t.close();
  }, 10000);

  it('a DT8 gear of the peer: ENABLE DEVICE TYPE folded into the packet', async () => {
    const port = 40000 + Math.floor(Math.random() * 10000);
    await start(port);
    const t = new Dali104Transport({ role: 'client', host: '127.0.0.1', port });
    const frames: BusFrame[] = [];
    t.onFrame((f) => frames.push(f));
    await t.open();
    await t.send({ data: Uint8Array.of(0xc1, 0x08) });
    await t.send({ data: Uint8Array.of(0x03, 0xf8) });            // DT8 QUERY COLOUR STATUS on the rgb gear (short address 1)
    await wait(300);
    expect(frames.some((f) => f.kind === 'backward' && f.dir === 'rx')).toBe(true);
    await t.close();
  }, 10000);
});
