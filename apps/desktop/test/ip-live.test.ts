import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Dali104Transport } from '@dali-scout/transports';
import { SourceManager } from '../src/main/source';
import { CH, type SimState } from '../src/shared';

const py = `
import socket, sys
sys.path.insert(0, ${JSON.stringify(resolve(__dirname, '../../../examples'))})
import struct
port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(1.0)
def fwd(seq, addr, op):
    adu = bytes([1, 0, 0, addr, op])
    return bytes([0xDA, 0x08, 0, seq >> 8, seq & 255, 0]) + struct.pack('>H', len(adu)) + adu
for i, (a, o) in enumerate([(0x01, 0xA0), (0x01, 0x90), (0x03, 0x99)]):
    s.sendto(fwd(i + 1, a, o), ('127.0.0.1', port))
    try:
        d, _ = s.recvfrom(600); print('ANSWER', d.hex(' '))
    except socket.timeout:
        print('NONE')
`;

describe('IP server + gear simulator through SourceManager', () => {
  it('answers a UDP controller', async () => {
    const states: SimState[] = [];
    const win: any = { webContents: { send: (ch: string, p: any) => { if (ch === CH.simState) states.push(p); } } };
    const mgr = new SourceManager(() => win);
    const t = new Dali104Transport({ role: 'server', port: 0, bindHost: '127.0.0.1' });
    await mgr.startLive(t, 'ip');
    const out = await new Promise<string>((res) => {
      const c = spawn('python3', ['-B', '-I', '-c', py, String(t.localPort)]);
      let o = '';
      c.stdout.on('data', (d) => { o += d; });
      c.stderr.on('data', (d) => { o += d; });
      c.on('close', () => res(o));
    });
    console.log(out);
    expect(out.match(/ANSWER/g)?.length).toBe(3);
    await mgr.stop();
  }, 15000);
});
