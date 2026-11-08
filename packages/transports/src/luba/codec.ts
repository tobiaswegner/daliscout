/**
 * LUBA protocol (Lunatone Universal Building and Automation Protocol, V1.10) codec for the
 * DALI-2 USB (art. 24138215-30) over USB-VCOM / RS232, 38400 8N1.
 * Message: 'Y' | CMD | LEN | DATA[LEN] | CHECKSUM (XOR of CMD, LEN, DATA). Multi-byte values are
 * little-endian unless the spec says big-endian (DALI frame payloads are big-endian).
 */
export const LUBA_SYNC = 0x59;

export const Cmd = {
  QUERY_DEVICE_DESCRIPTOR: 40, // response 41
  SETTINGS: 42,                // response 43
  READ_STATUS: 44,             // response 45
  EVENT: 49,
  ADD_FRAME: 50,               // response 51 (any bit length)
  ADD_FRAME_16: 52,            // response 53
  ADD_FRAME_24: 54,            // response 55
  AUTO_ANSWER: 82              // response 83
} as const;

export interface LubaMessage { cmd: number; data: Uint8Array }

export function encodeMessage(cmd: number, data: ArrayLike<number> = []): Uint8Array {
  if (data.length > 255) throw new RangeError('LUBA payload too long');
  const out = new Uint8Array(4 + data.length);
  out[0] = LUBA_SYNC; out[1] = cmd; out[2] = data.length;
  let x = cmd ^ data.length;
  for (let i = 0; i < data.length; i++) { out[3 + i] = data[i]!; x ^= data[i]!; }
  out[3 + data.length] = x & 0xff;
  return out;
}

/**
 * Streaming parser: tolerates split chunks, garbage between messages and bad checksums.
 * Limitation of the format (single sync byte): a stray 0x59 in garbage is taken as a header and
 * the parser waits for that many bytes before it can reject it and rescan. Nothing is lost, but
 * the next real message can be delayed until enough bytes have arrived.
 */
export class LubaParser {
  private buf: number[] = [];
  /** Bytes discarded while resynchronising (useful diagnostics). */
  droppedBytes = 0;
  checksumErrors = 0;

  push(chunk: Uint8Array): LubaMessage[] {
    for (const b of chunk) this.buf.push(b);
    const out: LubaMessage[] = [];
    for (;;) {
      const start = this.buf.indexOf(LUBA_SYNC);
      if (start < 0) { this.droppedBytes += this.buf.length; this.buf = []; break; }
      if (start > 0) { this.droppedBytes += start; this.buf.splice(0, start); }
      if (this.buf.length < 3) break;
      const len = this.buf[2]!;
      const total = 4 + len;
      if (this.buf.length < total) break;
      let x = 0;
      for (let i = 1; i < total - 1; i++) x ^= this.buf[i]!;
      if (x === this.buf[total - 1]) {
        out.push({ cmd: this.buf[1]!, data: Uint8Array.from(this.buf.slice(3, 3 + len)) });
        this.buf.splice(0, total);
      } else {
        this.checksumErrors++;
        this.droppedBytes++;
        this.buf.shift(); // the 'Y' was a coincidence (or the message is corrupt): rescan
      }
    }
    return out;
  }
}

// ---- requests ---------------------------------------------------------------------------

export const buildQueryDescriptor = () => encodeMessage(Cmd.QUERY_DEVICE_DESCRIPTOR);

export interface LubaSettings {
  /** Bit 7 DALI ping, bit 6 no TX in Initialize mode, bit 5 no TX in Quiescent mode. */
  mode: number;
  /** Bit set = event class disabled (see spec 2.4.1). 0 = everything incl. tick and line. */
  eventFilter: number;
  /** Bit 7: switch bus power supply on (if the hardware has one). */
  hardware: number;
}

export const buildReadSettings = () => encodeMessage(Cmd.SETTINGS);
export const buildWriteSettings = (s: LubaSettings) =>
  encodeMessage(Cmd.SETTINGS, [s.mode, s.eventFilter, s.hardware]);

export interface LubaTx {
  /** Frame bytes, big-endian, i.e. in bus order (address byte first). */
  data: Uint8Array;
  bits?: number;
  sendTwice?: boolean;
  waitForResponse?: boolean;
  /** DALI priority 1..5 (default 3). */
  priority?: number;
}

function txMode(f: LubaTx): number {
  const p = f.priority ?? 3;
  if (!Number.isInteger(p) || p < 1 || p > 5) throw new RangeError('priority must be 1..5');
  return (f.sendTwice ? 0x80 : 0) | (f.waitForResponse ? 0x40 : 0) | p;
}

export function buildAddFrame(frame: LubaTx, line = 0): Uint8Array {
  const bits = frame.bits ?? frame.data.length * 8;
  if (bits === 16 && frame.data.length === 2) {
    return encodeMessage(Cmd.ADD_FRAME_16, [line, txMode(frame), frame.data[0]!, frame.data[1]!]);
  }
  if (bits === 24 && frame.data.length === 3) {
    return encodeMessage(Cmd.ADD_FRAME_24, [line, txMode(frame), ...frame.data]);
  }
  if (bits < 1 || bits > 32 || frame.data.length !== Math.ceil(bits / 8)) {
    throw new RangeError(`Cannot send a ${bits}-bit frame from ${frame.data.length} byte(s)`);
  }
  // generic command: NrOfBits, Mode, 4 data bytes (big-endian, right-aligned)
  const v = new Uint8Array(4);
  v.set(frame.data, 4 - frame.data.length);
  return encodeMessage(Cmd.ADD_FRAME, [line, bits, txMode(frame), ...v]);
}

/** Configure one of 4 automatic answers (the interface replies to `frame` with `answer`). */
export function buildAutoAnswer(slot: number, bits: number, frame: Uint8Array, answer: number, line = 0): Uint8Array {
  if (!Number.isInteger(slot) || slot < 0 || slot > 3) throw new RangeError('auto answer slot must be 0..3');
  if (bits < 0 || bits > 32) throw new RangeError('bits must be 0..32');
  const f = new Uint8Array(4); // little-endian per spec for this command
  const be = new Uint8Array(4); be.set(frame, 4 - frame.length);
  for (let i = 0; i < 4; i++) f[i] = be[3 - i]!;
  return encodeMessage(Cmd.AUTO_ANSWER, [line, (slot << 6) | bits, ...f, answer]);
}

// ---- responses --------------------------------------------------------------------------

export interface LubaDescriptor {
  lines: number; bufferSize: number; tickUs: number; maxDataBytes: number;
  implementedMacros: Uint8Array; deviceListSpecifier: number;
  protocolMajor: number; protocolMinor: number;
  hasBusPowerSupply: boolean; hasBusShort: boolean;
}

export function parseDescriptor(d: Uint8Array): LubaDescriptor {
  if (d.length < 19) throw new Error(`Device descriptor too short (${d.length} bytes)`);
  return {
    lines: d[0]!, bufferSize: d[1]!,
    tickUs: (d[2]! | (d[3]! << 8) | (d[4]! << 16) | (d[5]! << 24)) >>> 0,
    maxDataBytes: d[6]!, implementedMacros: d.slice(7, 15), deviceListSpecifier: d[15]!,
    protocolMajor: d[16]!, protocolMinor: d[17]!,
    hasBusPowerSupply: (d[18]! & 0x80) !== 0, hasBusShort: (d[18]! & 0x10) !== 0
  };
}

export function parseSettings(d: Uint8Array): LubaSettings {
  if (d.length < 3) throw new Error('Settings response too short');
  return { mode: d[0]!, eventFilter: d[1]!, hardware: d[2]! };
}

export const TX_ERRORS: Record<number, string> = {
  1: 'bus voltage error', 2: 'device is in DALI Initialize mode', 3: 'device is in DALI Quiescent mode',
  4: 'send buffer full', 5: 'DALI line not available', 6: 'syntax error in parameters', 7: 'macro running'
};

/**
 * Response to the ADD ... FRAME commands: FirstID, or a single error byte 1..7.
 * (The spec marks NrOfFrames optional, so a 1-byte answer with a value 1..7 is read as an error.)
 */
export function parseAddFrameResponse(d: Uint8Array): { ok: true; firstId: number } | { ok: false; error: string } {
  if (d.length === 0) return { ok: false, error: 'empty response' };
  if (d.length === 1 && d[0]! >= 1 && d[0]! <= 7) return { ok: false, error: TX_ERRORS[d[0]!]! };
  return { ok: true, firstId: d[0]! };
}

// ---- events -----------------------------------------------------------------------------

export type LubaEvent =
  | { type: 'sent'; id: number; bits: number; frame: Uint8Array }
  | { type: 'auto-answer-sent'; answer: number }
  | { type: 'send-error'; id: number; reason: 'collision' | 'bus-error' | 'timeout' }
  | { type: 'response'; id: number; answer: 'none' | 'collision' | number }
  | { type: 'received'; bits: number; frame: Uint8Array }
  | { type: 'receive-error'; reason: 'start-stop-only' | 'framing' }
  | { type: 'bus'; event: 'bus-error' | 'system-error' | 'bus-restored' | 'buffer-full' | 'buffer-empty' | 'supply-warning' }
  | { type: 'other'; eventType: number; info: number; data: Uint8Array };

export interface ParsedEvent { tick?: number; line?: number; event: LubaEvent }

/** Take the low `bits` of a big-endian 32-bit word as bus-order bytes. */
export function frameBytes(word: Uint8Array, bits: number): Uint8Array {
  const n = Math.ceil(bits / 8);
  return word.slice(4 - n, 4);
}

/**
 * @param hasTick / hasLine whether the event filter lets tick and line index through
 *   (they are present when the corresponding eventFilter bits 3 / 2 are 0).
 */
export function parseEvent(d: Uint8Array, hasTick: boolean, hasLine: boolean): ParsedEvent {
  let i = 0;
  let tick: number | undefined, line: number | undefined;
  if (hasTick) { tick = d[i]! | (d[i + 1]! << 8); i += 2; }
  if (hasLine) { line = d[i]!; i += 1; }
  if (i >= d.length) throw new Error('Event message without status byte');
  const status = d[i++]!;
  const type = status >> 6, info = status & 0x3f;
  const rest = d.slice(i);
  const need = (n: number) => { if (rest.length < n) throw new Error(`Event type ${type}/${info} needs ${n} data bytes, got ${rest.length}`); };

  let event: LubaEvent;
  if (type === 0) {
    if (info >= 1 && info <= 32) { need(5); event = { type: 'sent', id: rest[0]!, bits: info, frame: frameBytes(rest.slice(1, 5), info) }; }
    else if (info === 60) { need(2); event = { type: 'auto-answer-sent', answer: rest[1]! }; }
    else if (info >= 61 && info <= 63) { need(1); event = { type: 'send-error', id: rest[0]!, reason: info === 61 ? 'collision' : info === 62 ? 'bus-error' : 'timeout' }; }
    else event = { type: 'other', eventType: type, info, data: rest };
  } else if (type === 1) {
    need(1);
    if (info === 0) event = { type: 'response', id: rest[0]!, answer: 'none' };
    else if (info === 8) { need(2); event = { type: 'response', id: rest[0]!, answer: rest[1]! }; }
    else if (info === 63) event = { type: 'response', id: rest[0]!, answer: 'collision' };
    else event = { type: 'other', eventType: type, info, data: rest };
  } else if (type === 2) {
    if (info >= 1 && info <= 32) { need(4); event = { type: 'received', bits: info, frame: frameBytes(rest.slice(0, 4), info) }; }
    else if (info === 62) event = { type: 'receive-error', reason: 'start-stop-only' };
    else if (info === 63) event = { type: 'receive-error', reason: 'framing' };
    else event = { type: 'other', eventType: type, info, data: rest };
  } else {
    const names: Record<number, Extract<LubaEvent, { type: 'bus' }>['event']> = {
      0: 'bus-error', 1: 'system-error', 2: 'bus-restored', 3: 'buffer-full', 4: 'buffer-empty', 5: 'supply-warning'
    };
    event = names[info] ? { type: 'bus', event: names[info]! } : { type: 'other', eventType: type, info, data: rest };
  }
  return { tick, line, event };
}

/**
 * Turns the wrapping 16-bit device tick into a monotonic microsecond timeline anchored at the
 * host clock. Long idle periods (more than one wrap) are resolved with host time.
 */
export class TickClock {
  private lastRaw?: number;
  private acc = 0;
  private anchor = 0;
  private lastHost = 0;

  constructor(private tickUs: number) {}

  setTickUs(us: number): void { this.tickUs = us; }

  /** @param hostNowUs current host clock in µs */
  stamp(raw: number | undefined, hostNowUs: number): number {
    if (raw === undefined || this.tickUs <= 0) return hostNowUs;
    if (this.lastRaw === undefined) {
      this.anchor = hostNowUs; this.acc = 0;
    } else {
      const base = (raw - this.lastRaw) & 0xffff;
      const hostTicks = (hostNowUs - this.lastHost) / this.tickUs;
      const wraps = Math.max(0, Math.round((hostTicks - base) / 65536));
      this.acc += base + wraps * 65536;
    }
    this.lastRaw = raw;
    this.lastHost = hostNowUs;
    return this.anchor + this.acc * this.tickUs;
  }
}
