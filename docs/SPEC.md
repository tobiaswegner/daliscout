# DALI Scout — Implementation Spec

## Context
DALI Scout is a desktop tool for DALI lighting engineers. It does two things:
1. **Monitor**: capture every telegram on a DALI bus (via USB interface or DALI-over-IP), then search, filter and decode them into human-readable form.
2. **Simulator**: emulate up to 65 DALI control gears (device types DT0 and DT8) with full internal state, reacting to commands from a real controller or from a built-in console, and visualise the resulting light output.

The repo is greenfield (LICENSE + `.devcontainer` with Node/npm/Python on Debian trixie, host networking). On approval of this plan, the first implementation step is to commit the spec section below as `docs/SPEC.md`.

**Decisions made with the user:** Electron desktop app · Lunatone/Tridonic DALI USB (HID) first · IP transport = DiiA Part 104 (user will supply spec + example code) · simulator works on both an internal virtual bus and a live bus.

**Assumptions to confirm (flagged, not blockers):**
- *"65 gears"*: a DALI bus has 64 short addresses (0–63). Spec allows up to **65 simulated gears** (configurable cap), shows a warning above 64 addressed gears, and lets the 65th stay unaddressed.
- *DT0 is fluorescent-lamp gear* (IEC 62386-201), not colour. It is simulated as a dimmable lamp with lamp-failure/power state. Colour (RGB/RGBW/RGB+CT/xy/Tc) is **DT8** (IEC 62386-209).
- *Live-bus simulation* requires an interface that can **transmit backward frames** (answers), flagged by `canReply`. **Findings (milestone 2 research):** the Lunatone DALI-2 USB speaks LUBA, which has *no* send-backward-frame command, only **4 fixed auto-answers** (frame → answer byte, `CONFIG AUTO ANSWER`), so it cannot emulate gears in general (`canReply = false`). The legacy DALI USB has an unused `SEND_ANSWER` (0x15) command code in the python-dali driver; whether it works is an open hardware experiment. Until proven, live-bus simulation needs other hardware or stays limited to receiving + updating state.
- Command tables in this spec are written from memory of IEC 62386-102/-103/-201/-209. **They must be verified against the standards** before being frozen; they live in data files (see §5) so corrections are cheap.

---

## 1. Tech stack & repo layout
- **Electron + TypeScript + React + Vite**, npm workspaces monorepo. Tests: **Vitest**. Packaging: electron-builder (Win/macOS/Linux).
- `packages/core` — pure TS, no IO, runs in Node and browser: frame model, decoder, command tables, gear simulation engine, virtual bus. **~80 % of logic and tests live here.**
- `packages/transports` — `DaliTransport` implementations: `lunatone-usb-hid`, `dali104-ip`, `virtual`, `replay`.
- `apps/desktop` — Electron main (owns transports, file IO, persistence) + renderer (React UI). IPC is typed and batched (UI receives frames in ≤16 ms batches).
- `packages/core/data/` — JSON command/device tables (`commands-102.json`; later `-103`, `-201`, `-209`).
- Dev note: the devcontainer is fine for `core` + `transports` work and tests (virtual/replay transports). Run the Electron app and USB/HID testing on the **host** (USB passthrough and GUI in the container are impractical).

## 2. Transport abstraction (`packages/transports`)
```ts
interface DaliTransport {
  id: string; label: string;
  caps: { canSniff: boolean; canSend: boolean; canReply: boolean; // backward frames
          hasHwTimestamps: boolean };
  open(): Promise<void>; close(): Promise<void>;
  send(f: TxFrame): Promise<TxResult>;        // forward frame, optional sendTwice, optional expectReply
  sendBackward?(byte: number, delayUs?: number): Promise<void>; // only if canReply
  on(event: 'frame', cb: (f: BusFrame) => void): void;  // also 'status' | 'error'
}
type BusFrame = { ts: number /*µs, monotonic; number so it survives IPC/JSON*/; dir: 'rx'|'tx'; kind: 'forward'|'backward'|'error';
                  bits: number; data: Uint8Array; error?: 'framing'|'collision'|'short'|'long'; source: string };
```
- **Lunatone DALI-2 USB, art. 24138215-30 — LUBA over USB serial** (`luba/`): documented in *LUBA Protocol V1.10* (38400 8N1; message `'Y' CMD LEN DATA XOR`). Implemented: streaming parser with resync, `QUERY DEVICE DESCRIPTOR`, read/modify/write `SETTINGS` (only `EventFilter` is changed, to enable all events with tick + line), `ADD 16/24-BIT/ANY FRAME TO TX BUFFER` (send-twice, wait-for-response, priority 1–5), `CONFIG AUTO ANSWER`, and the full **event** stream (frames sent/received, answers, collisions, bus faults). Timestamps come from the device's 16-bit tick (`Tick_us` from the descriptor), unwrapped against the host clock. `canReply = false`. Assumed, to verify on hardware: received/sent frame bytes in events are big-endian and right-aligned in the 4-byte field.
- **Legacy Tridonic/Lunatone DALI USB, art. 24138923 — HID 17b5:0020** (`hid/`): **no vendor documentation.** The 64-byte report layout comes from the open-source python-dali driver (`hid.py`) and is **unverified on hardware**; a second driver in that project names header fields differently. Implemented: init, send (16/24-bit, send-twice flag, sequence numbers 1–255), observed-traffic and response reports, status reports. No device timestamps (host clock; USB jitter of a few ms). `canReply = false`. **Verified on a real device (24138923, firmware 2.2):** HID 64-byte unnumbered reports, init exchange (firmware at bytes 3–4, serial at bytes 1–4 of the replies). **Still unverified:** sniffing of other masters, send/echo/answer reports. Validate with `node scripts/hid-probe.mjs` (dumps raw reports; `--send "FF 90"` transmits a frame). Linux needs `docs/udev/70-dali-usb.rules` and `libusb-1.0`.
- Device access lives in the app (`apps/desktop/src/main/devices.ts`: `node-hid`, `serialport`, loaded lazily); transports only see a `DeviceStream`, so they are fully testable with fakes.
- **DALI-over-IP (Part 104)**: implementation blocked on user-supplied spec + example code. Until then ship the interface + a stub with a loopback test server. Settings: host/port, protocol, reconnect with backoff.
- **Virtual bus**: in-process bus connecting simulated gears and the built-in console; models timing (backward frame 2.9–9.17 ms after forward frame, collision when several gears answer).
- **Replay**: plays back a capture file at 1×/N× speed (also used for tests and demos).
- Hot-plug detection, auto-reconnect, and a connection-status indicator in the UI.

## 3. Monitor
**Capture pipeline**: transport → ring buffer (default 1 M frames, spill to disk) → decoder → UI. Never block the transport on the UI.

**Telegram table** (virtualised, 100 k+ rows smooth): columns *#, Time (absolute / delta / relative), Dir, Raw hex (+bit length), Target (Broadcast / Group n / Short n / Special), Command (decoded name), Parameters, Answer, Comment/flags*. Colour-coding by class (arc power, config, query, special/commissioning, 24-bit control-device, errors). Answers are **correlated** to their query row (shown inline + linked), `no answer` shown explicitly for queries.

**Decoder (`core/decoder`)** returns a structured `Decoded` object `{ summary, target, command, params[], answer?, warnings[], layer }`, e.g. `Short 5 · DAPC 128 (3.21 %)`, `Group 3 · SET SCENE 4 (DTR0=200)`, `Short 12 · QUERY ACTUAL LEVEL → 0xFE (99.6 %)`, `DT8 · SET TEMPORARY Tc (DTR2:DTR1 = 0x0FA0 → 4000 K)`.
- 16-bit forward frames (IEC 62386-102): address byte formats (short `0AAAAAAS`, group `100AAAAS`, broadcast `1111111S`, broadcast-unaddressed `1111110S`), S-bit (DAPC vs command), special commands `0xA1–0xFD`, send-twice commands flagged, 8-bit backward frames.
- 24-bit control-device frames (-103): decode address/instance/opcode at a basic level; unknown shown as raw.
- **Stateful decode**: track DTR0/1/2, ENABLE DEVICE TYPE (`0xC1 xx` applies to the next command), and QUERY NEXT DEVICE TYPE so extended commands (`0xE0–0xFF`) resolve to DT0/DT8 names; interpret DT8 values (16-bit xy, Tc in mirek→kelvin, RGBWAF levels). Decode context is per-capture and recomputable.
- Anything unknown is displayed as raw with `unknown` flag, never dropped.
- Level display: raw (0–254), percent (log curve `10^((n-1)/253·3-1)`), and `MASK (0xFF)`.

**Search & filter**: free text over all columns; structured filters (direction, address type/value, command class, command name, level range, has-answer/no-answer, errors only, time window); regex toggle; saved filters/presets; highlight rules; find-next/prev; "follow tail" toggle; bookmark/annotate rows; "show only conversation with address N".

**Other features**: pause/resume display (capture continues), clear, statistics panel (frames/s, bus load, errors, per-address counts), send-frame panel (hex or decoded builder with command dropdown), export/import (**JSONL native `.dscap`**, CSV, plain text), copy row as hex/decoded.

## 4. Simulator
### 4.1 Gear model (`core/sim`)
Each `Gear` is a deterministic state machine driven by `(frame, now)` and a virtual clock, with no IO. Persisted state per IEC 62386-102:
- Identity: short address (0–63 or `MASK`/unassigned), 24-bit random address, group bitmask (16), device type(s), DTR0/1/2, `enableDeviceType`, `writeEnabled`, memory banks (0 and 1 minimal, read-only via READ MEMORY LOCATION).
- Levels: `actualLevel`, `targetLevel`, `lastActiveLevel`, `minLevel`, `maxLevel`, `physicalMin`, `powerOnLevel`, `systemFailureLevel`, `sceneLevel[16]`, fade time/rate/extended fade time, fade-in-progress state.
- Status: lamp failure, lamp on, limit error, fade running, reset state, missing short address, power-failure flag, operating mode.
- Commissioning state: `INITIALISE` (15-minute timer), `RANDOMISE`, `COMPARE`, `WITHDRAW`, `SEARCHADDR H/M/L`, `PROGRAM/VERIFY/QUERY SHORT ADDRESS`, `PHYSICAL SELECTION`, `PING`, so real commissioning tools can address simulated gears.
- Semantics: address matching (short/group/broadcast/unaddressed), **send-twice** window (≤100 ms) for configuration commands, DAPC sequence, UP/DOWN (200 ms fade-rate step), STEP UP/DOWN, ON AND STEP UP, STEP DOWN AND OFF, scenes, RESET to defaults, **fading** (fade time/rate tables, extended fade time, 1-ms-resolution virtual clock), clamp to min/max, arc-power 0 = off, MASK = no change. Query answers generate backward frames; no answer where the standard says none.
- **Answers**: backward frame sent via `bus.replyAfter(random 3–8 ms)`; if several gears answer (e.g. group queries, `COMPARE`), the bus models a collision/combined response per DALI semantics.

### 4.2 Device types
- **DT0 (fluorescent, -201)**: lamp-failure and lamp-on query, `REFERENCE SYSTEM POWER`, `ENABLE/DISABLE CURRENT PROTECTOR`, `SELECT DIMMING CURVE`, extended queries (dimming curve, failure status, operating mode), plus a user-toggle "simulate lamp failure". Visualised as a dimmable lamp with failure indicator.
- **DT8 (colour, -209)**: colour types selectable per gear — **xy**, **Tc (colour temp)**, **primary N**, **RGBWAF**, and combinations (RGB, RGBW, RGB+CT). Implements: `SET TEMPORARY X/Y/Tc/PRIMARY N/RGB/WAF/RGBWAF CONTROL`, `ACTIVATE`, `COLOUR TEMP STEP COOLER/WARMER`, `X/Y STEP UP/DOWN`, `COPY REPORT TO TEMPORARY`, `STORE TY FEATURES`, `STORE COLOUR TEMPERATURE LIMIT`, `ASSIGN COLOUR TO LINKED CHANNEL`, `START AUTO CALIBRATION`, queries (`GEAR FEATURES/STATUS`, `COLOUR STATUS`, `COLOUR TYPE FEATURES`, `COLOUR VALUE` (selected by DTR0), `RGBWAF CONTROL`, `ASSIGNED COLOUR`, `EXTENDED VERSION NUMBER`). "Temporary" vs "report" vs "actual" colour registers with ACTIVATE semantics; 16-bit values via DTR1/DTR2; MASK = 0xFFFF handling; colour fading governed by fade time; per-scene colour storage (scene colour tables).
  - Per-gear config: Tc range (e.g. 2700–6500 K, mirek), primaries count, channel-to-colour mapping, gamut triangle for xy, whether xy/Tc/RGBWAF are supported.
  - Conversions in `core/color`: xy ↔ sRGB (gamut-clipped), Tc → xy (Planckian approximation), RGBWAF → display colour. Unit-tested against reference values.

### 4.3 Gear management & UI
- Gear list (add up to 65; add N at once with templates; clone, delete, import/export JSON profiles, save/load whole scenario).
- **Overview grid**: tile per gear showing address, type, colour swatch glow scaled by level, level %, fade indicator, group badges, lamp-failure state. Click → **detail panel**: all registers live (editable), scene table, group membership, DT8 colour state (xy diagram with gamut + current point, Tc slider/scale, RGBW channel bars), fade graph, per-gear event log.
- Manual controls: arc-level slider, on/off, set colour, inject faults (lamp failure, power failure, no-answer, wrong answer, offline), reset.
- **Built-in controller console**: command builder (target + command dropdown + params) and quick actions (broadcast on/off, scenes, colour picker → DT8 command sequences), so the simulator is usable on the virtual bus without a controller.
- **Mode switch**: *Virtual bus* (simulator + console + monitor all attached) or *Live bus* (attached to a transport; gears answer a real controller; requires `canReply` for answers). Monitor shows both sides' traffic, simulator-originated answers are tagged `sim`.
- Playback speed control for fades (0.1×–10×) and pause of the virtual clock.

## 5. Data-driven command tables
`data/commands-*.json` entries: `{ code, name, sendTwice, answer: 'none'|'yes-no'|'byte'|'level'|'custom', params, stdRef, deviceType? }`. Decoder and gear engine share them (single source of truth). Include a CI test that every table entry has a decoder test and (for DT0/DT8) a simulator behaviour test.

## 6. Persistence & settings
Electron `userData`: interface profiles, filters/highlights, last scenario, UI layout; captures are user-chosen files. Settings for time format, level format, theme (light/dark), language (EN first; i18n keys from the start, German planned).

## 7. Non-functional
Sustain ≥ 1 000 frames/s without UI drops (theoretical bus max ≈ 50/s, so test with replay at high speed); decoder < 50 µs/frame; deterministic simulation (virtual clock) for reproducible tests; no network access except the user-configured IP transport; MIT licence stays.

## 8. Milestones
1. **Foundations**: monorepo, CI (lint, typecheck, vitest), `core` frame model + 102 decoder + tables, replay & virtual transports, minimal Electron shell with monitor table.
2. **Real hardware (USB)** — *software complete, hardware validation pending*: LUBA transport (DALI-2 USB) and legacy HID transport (DALI USB 24138923), device discovery and source selection, send panel, virtual-bus console source, structured filters + presets, CSV/text/.dscap export, statistics (frame rate, bus load, per-address counts). **Deferred:** highlight rules, bookmarks/annotations, find-next/prev, "conversation" shortcut in the UI (the address filter already follows queries and their answers). **Pending hardware:** confirm the HID report layout and sniffing completeness with `scripts/hid-probe.mjs`; test LUBA with a DALI-2 USB.
3. **Simulator core** — *implemented*: IEC 62386-102 gear state machine (`packages/core/src/sim/`), fading, scenes, groups, send-twice, commissioning, DTR/memory banks, fault injection; ordered virtual bus with optional wire-accurate timing; simulation clock (speed/pause); Simulator tab (tile grid, detail panel, broadcast quick actions, console, commission buttons). See "Simulator implementation notes" below.
4. **DT8 + DT0** — *implemented*: DT8 colour (xy, Tc, primary N, RGBWAF; presets RGB, RGBW, RGB+CT, CT, xy), DT0 lamp gear, colour fading, scene colours, colour decoding in the monitor, colour visualisation (lamp colour, CIE diagram, Tc slider, channel bars), colour controls that send real DT8 sequences over the bus, 65-gear mixed demo. See §12.
5. **Live-bus simulation**: attach gears to real transport, reply timing, `canReply` handling; end-to-end test with a real controller.
6. **DALI-over-IP (Part 104)**: implement from user-supplied spec/example code; loopback test server; reconnect handling.
7. **Polish & release**: DT edge cases, i18n, packaging for 3 OSes, docs, example captures/scenarios.

## 9. Verification
- **Unit (Vitest)**: decoder golden tests (hex → expected `Decoded`) incl. malformed/odd-length frames; address-byte matrix; level curve; every gear command (state before → frame → state after, answer byte); fade timing with virtual clock; send-twice window; DT8 colour conversions and ACTIVATE semantics.
- **Scenario tests**: commissioning of 64 simulated gears via a scripted DALI-2 commissioning sequence on the virtual bus must assign unique short addresses 0–63; 65-gear scenario loads and stays responsive.
- **Replay tests**: recorded real-bus captures (once available) decode with zero `unknown` for supported commands.
- **Manual / hardware**: connect Lunatone USB, verify sniffing of third-party master traffic, send a frame and see it echoed as `tx`; run a real controller against live-bus simulation; verify DALI-over-IP against the Part 104 reference once supplied.
- **UI**: run `npm run dev` on the host, load a demo capture (shipped in `examples/`), exercise search/filter; run the 65-gear demo scenario and visually check DT8 colour/CT states against sent commands.

## 10. Open items for the user
- Part 104 spec + example code (needed for Milestone 6).
- Output of `node scripts/hid-probe.mjs` (idle, with `--send "FF 90"`, and while another master talks) from the 24138923 to validate the HID layout; a DALI-2 USB (24138215-30) would allow testing the LUBA transport.
- Confirm the 65-gear / DT0 interpretation above.

## 11. Simulator implementation notes (milestone 3)
**Structure.** `Gear` (state machine, `process(frame, {busUs, simUs})`, `advance(simUs)`) · `Simulation` (set of gears, answer aggregation, change tracking, max 65) · `SimClock` (host clock × speed, pausable) · `commissionBus` (controller-side binary search, also used by the "Commission" buttons) · `attachSimulation` in `packages/transports` (feeds a transport's frames to the gears, sends answers back when `caps.canReply`) · `SimHost` in the app's main process (owns bus, gears, 50 ms tick, publishes snapshots to the UI).
**Two clocks.** The send-twice window (100 ms) uses *bus* time; fades and the 15-minute initialisation timer use *simulation* time, so slowing the simulation down does not break send-twice.
**Answers.** Identical answers from several gears form one valid backward frame; differing answers produce a `collision` error frame. Reply delay is a fixed 6 ms (spec range 2.9–9.17 ms), not random.
**Virtual bus.** Frames are queued so a reply never overtakes its query. With `wireTiming` frames occupy the bus for their real duration (forward 15.8 ms, backward 9.2 ms) with a 9.17 ms guard, so scripted sequences like commissioning show realistic timestamps and bus load.
**Not yet simulated / simplified** (candidates for later milestones): device types (hook exists: `Gear.extended`; DT0/DT8 are milestone 4), DALI-2 input devices (24-bit frames are ignored by gears), `PHYSICAL SELECTION` (no button to press), manufacturer-specific mode, persistence of simulator scenarios to disk, random reply delay, live-bus mode (milestone 5).
**Behaviour taken from memory of IEC 62386-102 — verify against the standard:**
- DAPC to 0 fades with the fade time; `OFF` and `RECALL MIN/MAX`, `STEP *`, `ON AND STEP UP` are immediate.
- Fading is linear in level steps; fading up from off starts at the minimum level, fading down to off passes the minimum level and switches off at the end.
- `UP`/`DOWN`: 200 ms at the fade rate, only when the lamp is on.
- Reset values: power-on 254, system failure level MASK, fade time 0, fade rate 7, scenes MASK, groups 0, random address 0xFFFFFF; `RESET` keeps the short address and the actual level.
- Version number answer 8 (DALI-2); `QUERY DEVICE TYPE`: 255 for none, the type for one, 254 for several (then `QUERY NEXT DEVICE TYPE`); `QUERY LIGHT SOURCE TYPE`: 255.
- Memory bank 0 layout (27 bytes, last location 0x1A) and a minimal writable bank 1; `READ MEMORY LOCATION` auto-increments DTR0.
- "Reset state" is cleared by configuration commands, not by arc power commands; "power failure" is cleared by arc power commands and `RESET`.
- Extended fade time: bits 6–4 multiplier (100 ms, 1 s, 10 s, 1 min), bits 3–0 base + 1; overrides the basic fade time when non-zero.

## 12. Device type implementation notes (milestone 4)
**Structure.** Device types are `GearExtension`s (`sim/ext.ts`, `dt8.ts`, `dt0.ts`) that own no state; their state lives in `GearState.dt8` / `GearState.dt0`, so snapshots, UI and tests stay plain data. `Gear` dispatches 0xE0–0xFF to the extension selected by the preceding ENABLE DEVICE TYPE, forwards scene store/remove/recall, reset and time advance. Extended commands share the send-twice machinery; an ENABLE DEVICE TYPE frame between the two copies does not cancel the pair.
**Monitor.** `data/commands-ext.json` names the DT0/DT8 extended commands; the decoder interprets DTR contents (x/y coordinates, Tc in mirek and K, RGB/WAF levels, query selectors) and the colour-status / colour-features answers. `seqSet*` builders (`build-dt8.ts`) generate the DTR + ENABLE DEVICE TYPE + command sequences used by the Simulator's colour controls and tests.
**Colour model.** Registers: temporary (written by SET TEMPORARY …), actual (displayed, fades), report (the colour being faded to). ACTIVATE merges temporary into report (MASK = unchanged) and fades actual over the gear's fade time. Display: xy → sRGB (gamut-clipped), Tc → black-body locus (Kim et al. approximation, 1667–25000 K), primaries / RGBWAF → additive mix of equal-flux primaries. The lamp tile uses colour × brightness (log curve; DT0 linear curve when selected).
**Simplifications.** Luminous flux of primaries (Ty) is not simulated; auto calibration completes instantly and does nothing; STORE GEAR FEATURES/STATUS is accepted without effect; colour is kept across a power cycle; DT0 fast fade time is stored and queried but does not change fading; REFERENCE SYSTEM POWER only runs a 15 s "measuring" flag; scene colours are captured from the temporary registers by SET SCENE (the standard's exact mechanism is unverified).
**Verify against the standards before relying on them:** all DT8 opcodes (0xE0–0xFF table), x/y/Tc step size (1 unit / 1 mirek), QUERY COLOUR VALUE selector layout (actual 0.., temporary 128.., report 192..; answer MSB with the LSB in DTR0 and MSB in DTR1), colour-status and colour-features bit layouts, DT8 extended version number (1), DT0 opcode table and queries (gear type 0, possible operating modes 0x01), which DT0/DT8 commands are send-twice (DT8 0xF0–0xF5, DT0 0xE0–0xE4).

## 13. Live-bus answer experiment (milestone 5 prerequisite)
`scripts/hid-answer-probe.mjs` tries the unused `SEND_ANSWER` (0x15) command of the legacy USB with a few report layouts and prints everything the device returns. Outcome decides the milestone 5 design: if the device emits a backward frame (visible as an OBSERVED/RESPONSE DALI8 report or on a scope), the legacy transport gets `sendBackward` and `canReply = true`; otherwise live simulation is limited to following traffic, and a DIY serial transceiver transport is the alternative.

**Result (hardware, legacy DALI USB 24138923, firmware 2.2).** `SEND_ANSWER` works:
- Report layout `[0x15, answerByte, 0…]`; the device acknowledges with `15 00 …` and then reports its own answer as `OBSERVED DALI8` (kind 0x11, type 0x72, byte at index 5). Other fields (mode) are irrelevant.
- `scripts/hid-answer-latency.mjs` answered a real controller's `03 90` (QUERY STATUS, short address 1) with status 0x00. The controller then began configuring address 1 (`A3 02`, `03 2E` twice, `02 00`), so the answer reached the bus and was valid.
- Timing: host write 0.8–2.2 ms after the query report; the answer was observed complete ~12–13 ms after the query report, i.e. it started ~3–4 ms after the query (window 2.9–9.17 ms). Reply latency is USB-bound and cannot be scheduled, so `delayUs` is ignored. Two samples only; collect more under load.
- Not possible: collisions (`sendCollision`), since only valid 8-bit frames can be sent. Gears that would collide stay silent instead.
- The legacy transport therefore has `canReply = true` and labels the re-observed answer `tx`.
