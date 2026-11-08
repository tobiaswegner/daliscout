import { useMemo, useState } from 'react';
import {
  buildCommand, buildDapc, fadeRateStepsPerSecond, fadeTimeSeconds, extendedFadeUs, levelToPercent, toHex,
  type GearState, type Row
} from '@dali-scout/core';
import type { SimCommand, SimCommandResult, SimGearView, SimState } from '../../shared';
import { SendPanel } from './SendPanel';

interface Props {
  sim: SimState;
  run: (c: SimCommand) => Promise<SimCommandResult>;
  /** True when the virtual bus is the active source (the simulator is only live then). */
  active: boolean;
  canSend: boolean;
  recent: Row[];
}

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10];

export function Simulator({ sim, run, active, canSend, recent }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [count, setCount] = useState(8);
  const [addressed, setAddressed] = useState(true);
  const [scene, setScene] = useState(0);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);

  const gears = useMemo(
    () => [...sim.gears].sort((a, b) => (a.state.shortAddress ?? 99) - (b.state.shortAddress ?? 99) || a.id - b.id),
    [sim.gears]
  );
  const sel = sim.gears.find((g) => g.id === selected);
  const unaddressed = sim.gears.filter((g) => g.state.shortAddress === null).length;

  const exec = async (c: SimCommand) => {
    const r = await run(c);
    setMessage(r.ok ? (r.message ? { ok: true, text: r.message } : null) : { ok: false, text: r.error });
  };
  const sendHex = async (bytes: Uint8Array) => {
    const r = await window.dali.send({ hex: toHex(bytes), sendTwice: false, expectReply: false });
    if (!r.ok) setMessage({ ok: false, text: r.error });
  };

  if (!active) {
    return (
      <div className="sim-empty">
        <h2>Gear simulator</h2>
        <p>The simulated gears live on the virtual bus.</p>
        <button onClick={() => window.dali.connect({ kind: 'virtual' })}>Start virtual bus</button>
      </div>
    );
  }

  const busy = !!sim.busy;
  return (
    <div className="sim">
      <div className="toolbar second">
        <span>Add</span>
        <input type="number" min={1} max={65} value={count} style={{ width: 56 }} onChange={(e) => setCount(Number(e.target.value))} />
        <label className="inline"><input type="checkbox" checked={addressed} onChange={(e) => setAddressed(e.target.checked)} /> with short addresses</label>
        <button disabled={busy} onClick={() => exec({ type: 'add', count, addressed })}>Add gears</button>
        <button disabled={busy || sim.gears.length === 0} onClick={() => { if (confirm('Remove all simulated gears?')) void exec({ type: 'clear' }); }}>Remove all</button>
        <span className="sep" />
        <button disabled={busy || sim.gears.length === 0} onClick={() => exec({ type: 'commission', all: false })}
          title="Binary-search commissioning of gears without a short address">
          Commission unaddressed ({unaddressed})
        </button>
        <button disabled={busy || sim.gears.length === 0} onClick={() => exec({ type: 'commission', all: true })}
          title="Re-address every gear">Re-address all</button>
        <span className="sep" />
        <label>Speed{' '}
          <select value={sim.speed} onChange={(e) => exec({ type: 'speed', value: Number(e.target.value) })}>
            {SPEEDS.includes(sim.speed) ? null : <option value={sim.speed}>{sim.speed}×</option>}
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </label>
        <button onClick={() => exec({ type: 'pause', value: !sim.paused })}>{sim.paused ? '▶ Resume time' : '⏸ Pause time'}</button>
        <span className="grow" />
        <span className={sim.gears.length > 64 ? 'warn' : 'muted'}>
          {sim.gears.length} / {sim.maxGears} gears{sim.gears.length > 64 ? ' — a DALI bus has only 64 addresses' : ''}
        </span>
      </div>

      <div className="toolbar second quick">
        <strong>Broadcast</strong>
        <button disabled={!canSend} onClick={() => sendHex(buildDapc({ kind: 'broadcast' }, 254))}>On</button>
        <button disabled={!canSend} onClick={() => sendHex(buildDapc({ kind: 'broadcast' }, 0))}>Off</button>
        <button disabled={!canSend} onClick={() => sendHex(buildCommand({ kind: 'broadcast' }, 0x05))}>Max</button>
        <button disabled={!canSend} onClick={() => sendHex(buildCommand({ kind: 'broadcast' }, 0x06))}>Min</button>
        <span className="sep" />
        <label>Scene{' '}
          <select value={scene} onChange={(e) => setScene(Number(e.target.value))}>
            {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </label>
        <button disabled={!canSend} onClick={() => sendHex(buildCommand({ kind: 'broadcast' }, 0x10 + scene))}>Go to scene</button>
        <span className="sep" />
        <button className={consoleOpen ? 'on' : ''} onClick={() => setConsoleOpen((v) => !v)}>Console…</button>
        {sim.busy && <span className="busy">⏳ {sim.busy}</span>}
        {message && <span className={message.ok ? 'ok' : 'warn'}>{message.ok ? '✓' : '⚠'} {message.text}</span>}
      </div>

      {consoleOpen && <SendPanel canSend={canSend} />}

      <div className="sim-main">
        <div className="sim-left">
          {gears.length === 0 && <div className="muted pad">No gears. Add some with the toolbar above.</div>}
          <div className="grid-tiles">
            {gears.map((g) => (
              <Tile key={g.id} g={g} selected={g.id === selected} onClick={() => setSelected(g.id)} />
            ))}
          </div>
          <Recent rows={recent} />
        </div>
        {sel && <Detail g={sel} run={exec} onGone={() => setSelected(null)} />}
      </div>
    </div>
  );
}

// ---- visuals ---------------------------------------------------------------------------------

/** Perceived brightness 0..1 of a level (the DALI curve is logarithmic, perception about linear in %). */
const brightness = (level: number) => levelToPercent(level) / 100;

function lampStyle(s: GearState): React.CSSProperties {
  const i = s.faults.lampFailure ? 0 : brightness(s.actualLevel);
  return {
    background: `radial-gradient(circle at 50% 40%, rgba(255,236,190,${0.35 + 0.65 * i}), rgba(255,184,77,${0.15 + 0.85 * i}))`,
    opacity: i === 0 ? 0.18 : 0.25 + 0.75 * i,
    boxShadow: i > 0 ? `0 0 ${6 + 26 * i}px ${2 + 8 * i}px rgba(255,200,110,${0.15 + 0.6 * i})` : 'none'
  };
}

function Lamp({ s, size = 44 }: { s: GearState; size?: number }) {
  return (
    <div className={`lamp ${s.identifyUntilUs ? 'identify' : ''} ${s.faults.lampFailure ? 'failed' : ''}`}
      style={{ width: size, height: size }}>
      <div className="glow" style={lampStyle(s)} />
      {s.faults.lampFailure && <span className="x">⚠</span>}
    </div>
  );
}

const addr = (s: GearState) => (s.shortAddress === null ? '—' : String(s.shortAddress));

function Tile({ g, selected, onClick }: { g: SimGearView; selected: boolean; onClick: () => void }) {
  const s = g.state;
  const pct = levelToPercent(s.actualLevel);
  const trend = s.fade ? (s.fade.targetLevel > s.actualLevel ? '↗' : '↘') : '';
  const groups = Array.from({ length: 16 }, (_, i) => i).filter((i) => s.groups & (1 << i));
  return (
    <button className={`tile ${selected ? 'selected' : ''} ${s.faults.offline ? 'offline' : ''} ${s.shortAddress === null ? 'unaddr' : ''}`}
      onClick={onClick} title={s.name}>
      <Lamp s={s} />
      <div className="t-addr">{s.shortAddress === null ? 'no address' : `A${s.shortAddress}`}</div>
      <div className="t-level">{s.actualLevel === 0 ? 'off' : `${pct < 10 ? pct.toFixed(1) : Math.round(pct)} %`} {trend}</div>
      <div className="t-badges">
        {s.deviceTypes.map((d) => <span key={d} className="badge">DT{d}</span>)}
        {groups.slice(0, 4).map((i) => <span key={i} className="badge g">G{i}</span>)}
        {groups.length > 4 && <span className="badge g">+{groups.length - 4}</span>}
        {s.faults.offline && <span className="badge bad">offline</span>}
        {s.faults.noAnswer && <span className="badge bad">mute</span>}
        {s.init !== 'disabled' && <span className="badge init">{s.init === 'withdrawn' ? 'withdrawn' : 'init'}</span>}
      </div>
    </button>
  );
}

function Recent({ rows }: { rows: Row[] }) {
  return (
    <div className="recent">
      <div className="muted">Recent telegrams</div>
      {rows.length === 0 && <div className="muted">— none yet</div>}
      {rows.map((r) => (
        <div key={r.seq} className={`rline k-${r.decoded.class}`}>
          <span className="mono">{toHex(r.frame.data)}</span>
          <span>{r.decoded.summary}</span>
          {r.decoded.answer && <span className="muted">→ {r.decoded.answer}</span>}
        </div>
      ))}
    </div>
  );
}

// ---- detail ----------------------------------------------------------------------------------

function Detail({ g, run, onGone }: { g: SimGearView; run: (c: SimCommand) => Promise<void>; onGone: () => void }) {
  const s = g.state;
  const pct = levelToPercent(s.actualLevel);
  const fadeTxt = s.extendedFadeTime && extendedFadeUs(s.extendedFadeTime) > 0
    ? `${(extendedFadeUs(s.extendedFadeTime) / 1e6).toFixed(1)} s (extended)`
    : s.fadeTime === 0 ? 'none' : `${fadeTimeSeconds(s.fadeTime).toFixed(1)} s`;
  const lvl = (v: number) => (v === 255 ? 'MASK' : `${v}${v > 0 ? ` (${levelToPercent(v) < 10 ? levelToPercent(v).toFixed(2) : levelToPercent(v).toFixed(1)} %)` : ''}`);

  return (
    <aside className="detail-sim">
      <div className="d-head">
        <Lamp s={s} size={72} />
        <div>
          <input className="name" defaultValue={s.name} key={`${g.id}-${s.name}`}
            onBlur={(e) => e.target.value !== s.name && run({ type: 'rename', id: g.id, name: e.target.value })} />
          <div className="muted">Address {addr(s)} · {s.actualLevel === 0 ? 'off' : `${pct.toFixed(1)} %`}
            {s.fade ? ' · fading' : ''} · {s.deviceTypes.length ? s.deviceTypes.map((d) => `DT${d}`).join(', ') : 'plain gear'}</div>
        </div>
      </div>

      <label className="slider">Level {s.actualLevel}
        <input type="range" min={0} max={254} value={s.actualLevel}
          onChange={(e) => run({ type: 'setLevel', id: g.id, level: Number(e.target.value) })} />
      </label>
      <div className="row-btns">
        <button onClick={() => run({ type: 'setLevel', id: g.id, level: 0 })}>Off</button>
        <button onClick={() => run({ type: 'setLevel', id: g.id, level: s.minLevel })}>Min</button>
        <button onClick={() => run({ type: 'setLevel', id: g.id, level: s.maxLevel })}>Max</button>
        <button onClick={() => run({ type: 'powerCycle', id: g.id })} title="Remove and restore power">Power cycle</button>
        <button onClick={() => run({ type: 'clone', id: g.id })}>Clone</button>
        <button onClick={async () => { await run({ type: 'remove', id: g.id }); onGone(); }}>Remove</button>
      </div>

      <fieldset>
        <legend>Fault injection</legend>
        <label className="inline"><input type="checkbox" checked={s.faults.lampFailure}
          onChange={(e) => run({ type: 'fault', id: g.id, patch: { lampFailure: e.target.checked } })} /> Lamp failure</label>
        <label className="inline"><input type="checkbox" checked={s.faults.noAnswer}
          onChange={(e) => run({ type: 'fault', id: g.id, patch: { noAnswer: e.target.checked } })} /> Never answers</label>
        <label className="inline"><input type="checkbox" checked={s.faults.offline}
          onChange={(e) => run({ type: 'fault', id: g.id, patch: { offline: e.target.checked } })} /> Offline</label>
      </fieldset>

      <table className="regs">
        <tbody>
          <tr><th>Actual / target</th><td>{lvl(s.actualLevel)} → {lvl(s.targetLevel)}</td></tr>
          <tr><th>Last active</th><td>{lvl(s.lastActiveLevel)}</td></tr>
          <tr><th>Min / max / phys. min</th><td>{s.minLevel} / {s.maxLevel} / {s.physicalMin}</td></tr>
          <tr><th>Power on / system failure</th><td>{lvl(s.powerOnLevel)} / {lvl(s.systemFailureLevel)}</td></tr>
          <tr><th>Fade time / rate</th><td>{fadeTxt} / {s.fadeRate} ({fadeRateStepsPerSecond(s.fadeRate).toFixed(1)} steps/s)</td></tr>
          <tr><th>DTR0 / 1 / 2</th><td className="mono">{s.dtr0} / {s.dtr1} / {s.dtr2}</td></tr>
          <tr><th>Random / search</th><td className="mono">{hex24(s.randomAddress)} / {hex24(s.searchAddress)}</td></tr>
          <tr><th>Initialisation</th><td>{s.init}</td></tr>
          <tr><th>Flags</th><td>{[s.limitError && 'limit error', s.resetState && 'reset state', s.powerFailure && 'power failure', s.fade && 'fade running'].filter(Boolean).join(', ') || '—'}</td></tr>
        </tbody>
      </table>

      <div className="sub">Groups</div>
      <div className="chips">
        {Array.from({ length: 16 }, (_, i) => (
          <span key={i} className={`chip small ${s.groups & (1 << i) ? 'on' : ''}`}>{i}</span>
        ))}
      </div>
      <div className="sub">Scenes</div>
      <div className="scenes">
        {s.scenes.map((v, i) => (
          <div key={i} className={`scene ${v === 255 ? 'none' : ''}`} title={v === 255 ? 'not in scene' : lvl(v)}>
            <small>{i}</small>{v === 255 ? '–' : v}
          </div>
        ))}
      </div>
    </aside>
  );
}

const hex24 = (v: number) => v.toString(16).padStart(6, '0').toUpperCase();
