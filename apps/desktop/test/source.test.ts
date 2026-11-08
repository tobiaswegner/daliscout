import { describe, expect, it } from 'vitest';
import { makeFrame, type BusFrame } from '@dali-scout/core';
import { TransportBase, type TransportCaps } from '@dali-scout/transports';
import { SourceManager } from '../src/main/source';
import { CH, type SourceInfo } from '../src/shared';

const setup = () => {
  const sent: { ch: string; payload: any }[] = [];
  const win: any = { webContents: { send: (ch: string, payload: unknown) => sent.push({ ch, payload }) } };
  const mgr = new SourceManager(() => win);
  const sources = () => sent.filter((s) => s.ch === CH.source).map((s) => s.payload as SourceInfo);
  const frames = () => sent.filter((s) => s.ch === CH.frames).flatMap((s) => s.payload as BusFrame[]);
  return { mgr, sent, sources, frames };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FailingTransport extends TransportBase {
  caps: TransportCaps = { canSniff: true, canSend: false, canReply: false, hasHwTimestamps: false };
  constructor() { super('bad', 'Bad device'); }
  async open() { throw new Error('Permission denied'); }
  async close() { /* nothing */ }
}

describe('SourceManager', () => {
  it('virtual bus: reports canSend, sends frames (twice) and batches them to the renderer', async () => {
    const { mgr, sources, frames, sent } = setup();
    await mgr.startVirtual();
    expect(sources().at(-1)).toMatchObject({ state: 'running', kind: 'virtual', canSend: true });

    expect(await mgr.send({ hex: 'FF 90', sendTwice: true, expectReply: true })).toEqual({ ok: true });
    await mgr.send({ hex: '0xFE, 0x00', sendTwice: false, expectReply: false });
    await wait(40);
    expect(frames().map((f) => `${f.dir} ${Array.from(f.data).map((b) => b.toString(16)).join('')}`))
      .toEqual(['tx ff90', 'tx ff90', 'tx fe0']);
    // three frames, one IPC message: batching works
    expect(sent.filter((s) => s.ch === CH.frames)).toHaveLength(1);
    await mgr.stop();
  });

  it('send errors are returned, not thrown', async () => {
    const { mgr } = setup();
    expect(await mgr.send({ hex: 'FF', sendTwice: false, expectReply: false })).toMatchObject({ ok: false, error: /cannot send/ });
    await mgr.startVirtual();
    expect(await mgr.send({ hex: 'F', sendTwice: false, expectReply: false })).toMatchObject({ ok: false, error: /Odd number/ });
    await mgr.stop();
  });

  it('replay sources cannot send and finish cleanly', async () => {
    const { mgr, sources, frames } = setup();
    await mgr.startReplay([makeFrame('0B A0', { ts: 0 }), makeFrame('FE', { ts: 1000 })], 'file.dscap');
    expect(sources().at(-1)).toMatchObject({ state: 'running', kind: 'replay', canSend: false });
    expect(await mgr.send({ hex: 'FF 00', sendTwice: false, expectReply: false })).toMatchObject({ ok: false });
    await wait(60);
    expect(frames()).toHaveLength(2);
    expect(sources().at(-1)).toMatchObject({ state: 'finished' });
  });

  it('a device that fails to open is reported as an error', async () => {
    const { mgr, sources } = setup();
    await mgr.attach(new FailingTransport(), 'Bad device', 'device');
    const last = sources().at(-1)!;
    expect(last).toMatchObject({ state: 'error', kind: 'device' });
    expect(last.error).toBe('Permission denied');
    expect(await mgr.send({ hex: 'FF 00', sendTwice: false, expectReply: false })).toMatchObject({ ok: false });
  });

  it('switching sources stops the previous one', async () => {
    const { mgr, sources } = setup();
    await mgr.startVirtual();
    await mgr.startReplay([makeFrame('0B A0', { ts: 0 })], 'x');
    expect(sources().filter((s) => s.state === 'running').map((s) => s.kind)).toEqual(['virtual', 'replay']);
    await mgr.stopAndReport();
    expect(sources().at(-1)).toMatchObject({ state: 'idle' });
  });
});
