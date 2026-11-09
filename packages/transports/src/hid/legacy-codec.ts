/**
 * Legacy Tridonic/Lunatone "DALI USB" (art. 24138923, USB VID 0x17B5 / PID 0x0020), HID,
 * fixed 64-byte reports.
 *
 * !! There is no vendor documentation. The layout below is taken from the open-source driver
 * python-dali (dali/driver/hid.py, class `tridonic`) and is UNVERIFIED on hardware. A second
 * driver in the same project (tridonic.py) uses slightly different header field names, so run
 * `node scripts/hid-probe.mjs` against a real device before relying on it.
 *
 * Host -> device:  [0]=cmd [1]=seq [2]=flags [3]=mode [4..7]=frame (big-endian, right-aligned)
 *                  [8]=dtr0 [9]=prio [10]=devtype, rest zero
 * Device -> host:  [0]=kind (0x01 info, 0x11 observed on bus, 0x12 response to our command)
 *                  [1]=type (0x71 no frame, 0x72 8-bit, 0x73 16-bit, 0x74 25-bit, 0x76 24-bit, 0x77 status)
 *                  [2..5]=frame (right-aligned) [6..7]=interval [8]=seq
 */
export const REPORT_SIZE = 64;
export const USB_VENDOR_ID = 0x17b5;
export const USB_PRODUCT_ID = 0x0020;

export const CMD_INIT = 0x01;
export const CMD_SEND = 0x12;
/** Transmit an 8-bit backward frame. Verified on hardware: the device emitted and re-observed byte [1]. */
export const CMD_SEND_ANSWER = 0x15;
export const FLAG_SEND_TWICE = 0x20;
export const MODE_DALI16 = 3;
export const MODE_DALI24 = 6;

export function encodeInit(sub: 0x00 | 0x02): Uint8Array {
  const r = new Uint8Array(REPORT_SIZE);
  r[0] = CMD_INIT; r[1] = sub; // sub 0 = firmware version, 2 = serial number
  return r;
}

export function encodeSend(seq: number, bits: number, data: Uint8Array, sendTwice: boolean): Uint8Array {
  if (!Number.isInteger(seq) || seq < 1 || seq > 255) throw new RangeError('seq must be 1..255');
  const mode = bits === 16 ? MODE_DALI16 : bits === 24 ? MODE_DALI24 : 0;
  if (!mode || data.length !== bits / 8) {
    throw new RangeError(`The legacy DALI USB can only send 16- and 24-bit frames (got ${bits} bits)`);
  }
  const r = new Uint8Array(REPORT_SIZE);
  r[0] = CMD_SEND; r[1] = seq; r[2] = sendTwice ? FLAG_SEND_TWICE : 0; r[3] = mode;
  r.set(data, 8 - data.length); // right-aligned in the 4-byte frame field at [4..7]
  return r;
}

/** Backward-frame request: `[0x15, answerByte, 0...]`. The other fields made no difference in the probe. */
export function encodeAnswer(byte: number): Uint8Array {
  if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new RangeError('answer must be a byte');
  const r = new Uint8Array(REPORT_SIZE);
  r[0] = CMD_SEND_ANSWER; r[1] = byte;
  return r;
}

export type ReportKind = 'info' | 'observed' | 'response';
export type ReportType = 'no-frame' | 'dali8' | 'dali16' | 'edali25' | 'dali24' | 'status' | 'unknown';

export interface Report {
  kind: ReportKind | 'unknown';
  type: ReportType;
  rawType: number;
  /** The 4-byte frame field, right-aligned. */
  frame: Uint8Array;
  interval: number;
  seq: number;
  raw: Uint8Array;
}

const KINDS: Record<number, ReportKind> = { 0x01: 'info', 0x11: 'observed', 0x12: 'response' };
const TYPES: Record<number, ReportType> = {
  0x71: 'no-frame', 0x72: 'dali8', 0x73: 'dali16', 0x74: 'edali25', 0x76: 'dali24', 0x77: 'status'
};

export function decodeReport(raw: Uint8Array): Report {
  if (raw.length < 9) throw new Error(`HID report too short (${raw.length} bytes)`);
  return {
    kind: KINDS[raw[0]!] ?? 'unknown',
    type: TYPES[raw[1]!] ?? 'unknown',
    rawType: raw[1]!,
    frame: raw.slice(2, 6),
    interval: (raw[6]! << 8) | raw[7]!,
    seq: raw[8]!,
    raw
  };
}

/** Bits and bus-order bytes carried by a frame-type report, or undefined for non-frame types. */
export function reportFrame(r: Report): { bits: number; data: Uint8Array } | undefined {
  switch (r.type) {
    case 'dali8': return { bits: 8, data: r.frame.slice(3, 4) };
    case 'dali16': return { bits: 16, data: r.frame.slice(2, 4) };
    case 'dali24': return { bits: 24, data: r.frame.slice(1, 4) };
    case 'edali25': return { bits: 25, data: r.frame.slice(0) };
    default: return undefined;
  }
}

/** Status codes carried in byte 5 of a type 0x77 report. */
export const STATUS = { CHECKSUM: 1, SHORTED: 2, FRAMING_ERROR: 3, OK: 4, DSI_MODE: 5, DALI_MODE: 6 } as const;
export const reportStatus = (r: Report): number => r.frame[3]!;
