import { useMemo, useState } from 'react';
import {
  Decoder, allCommands, buildCommand, buildDapc, makeFrame, parseHexInput, toHex, type TargetSpec
} from '@dali-scout/core';

type Mode = 'dapc' | 'command' | 'raw';
type TargetKind = TargetSpec['kind'];

const COMMANDS = allCommands.flatMap((d) =>
  Array.from({ length: d.range ?? 1 }, (_, i) => ({
    opcode: d.code + i, name: d.param ? `${d.name} ${i}` : d.name, twice: !!d.sendTwice, query: !!d.answer
  })));

export function SendPanel({ canSend }: { canSend: boolean }) {
  const [mode, setMode] = useState<Mode>('command');
  const [kind, setKind] = useState<TargetKind>('broadcast');
  const [addr, setAddr] = useState(0);
  const [level, setLevel] = useState(254);
  const [opcode, setOpcode] = useState(0);
  const [raw, setRaw] = useState('FF 90');
  const [twice, setTwice] = useState(false);
  const [reply, setReply] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const built = useMemo(() => {
    try {
      const target: TargetSpec = kind === 'short' || kind === 'group' ? { kind, value: addr } : { kind };
      const bytes = mode === 'raw' ? parseHexInput(raw)
        : mode === 'dapc' ? buildDapc(target, level) : buildCommand(target, opcode);
      const hex = toHex(bytes);
      const summary = bytes.length === 2 ? new Decoder().decode(makeFrame(hex)).summary : `${bytes.length * 8}-bit frame`;
      return { hex, summary, error: undefined as string | undefined };
    } catch (e) {
      return { hex: '', summary: '', error: (e as Error).message };
    }
  }, [mode, kind, addr, level, opcode, raw]);

  const pickCommand = (op: number) => {
    setOpcode(op);
    const c = COMMANDS.find((x) => x.opcode === op);
    if (c) { setTwice(c.twice); setReply(c.query); }
  };

  const send = async () => {
    const res = await window.dali.send({ hex: built.hex, sendTwice: twice, expectReply: reply });
    setStatus(res.ok ? { ok: true, text: `Sent ${built.hex}${twice ? ' (twice)' : ''}` } : { ok: false, text: res.error });
  };

  return (
    <section className="panel send">
      {!canSend && <div className="muted">The current source cannot send. Connect a device or the virtual bus.</div>}
      <div className="grid">
        <label>Frame type
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="command">Command</option><option value="dapc">Direct arc power</option><option value="raw">Raw hex</option>
          </select>
        </label>
        {mode !== 'raw' && (
          <label>Target
            <span className="pair">
              <select value={kind} onChange={(e) => setKind(e.target.value as TargetKind)}>
                <option value="short">short address</option><option value="group">group</option>
                <option value="broadcast">broadcast</option><option value="broadcast-unaddressed">broadcast unaddressed</option>
              </select>
              <input type="number" min={0} max={kind === 'group' ? 15 : 63} style={{ width: 64 }}
                disabled={kind !== 'short' && kind !== 'group'} value={addr} onChange={(e) => setAddr(Number(e.target.value))} />
            </span>
          </label>
        )}
        {mode === 'dapc' && (
          <label>Level (0–254, 255 = MASK)
            <input type="number" min={0} max={255} value={level} onChange={(e) => setLevel(Number(e.target.value))} />
          </label>
        )}
        {mode === 'command' && (
          <label>Command
            <select value={opcode} onChange={(e) => pickCommand(Number(e.target.value))}>
              {COMMANDS.map((c) => <option key={c.opcode} value={c.opcode}>{c.name}</option>)}
            </select>
          </label>
        )}
        {mode === 'raw' && (
          <label>Hex bytes
            <input className="mono" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="FF 90" />
          </label>
        )}
        <label className="inline"><input type="checkbox" checked={twice} onChange={(e) => setTwice(e.target.checked)} /> Send twice</label>
        <label className="inline"><input type="checkbox" checked={reply} onChange={(e) => setReply(e.target.checked)} /> Expect reply</label>
        <button onClick={send} disabled={!canSend || !!built.error || !built.hex}>Send</button>
      </div>
      <div className="mono preview">
        {built.error ? <span className="warn">⚠ {built.error}</span> : <>{built.hex} <span className="muted">→ {built.summary}</span></>}
      </div>
      {status && <div className={status.ok ? 'ok' : 'warn'}>{status.ok ? '✓' : '⚠'} {status.text}</div>}
    </section>
  );
}
