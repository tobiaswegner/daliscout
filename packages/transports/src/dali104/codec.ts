/**
 * DALI-over-IP (IEC 62386-104, Annex B.5, UDP) packet format.
 *
 * !! Derived from an example implementation of a DALI-over-IP peer, not from the standard text (only the
 * send-twice rule of 9.4 was checked against it). Fields that implementation ignores are marked "?".
 *
 *   NDU (network data unit)
 *     [0]    0xDA start byte
 *     [1]    0x08 forward packet (client -> telecommunication unit), 0x88 backward packet (answer)
 *            (the top two bits must be 0 on forward packets; 0x80 marks backward)
 *     [2]    flags; bit 7 = DTLS (unsupported -> ignored)
 *     [3..4] sequence number, big-endian; the answer carries the sequence number of its query
 *     [5]    system address ("telecommunication unit")
 *     [6..7] ADU length, big-endian, low 10 bits
 *     [8..]  ADU
 *   ADU
 *     [0]    transaction type ? (0x01)
 *     [1]    source ? (0x00)
 *     [2]    format; bit 7 = a device type byte follows (this replaces a separate ENABLE DEVICE TYPE frame)
 *     [3]    device type (bit 7 of this byte ignored), only when the format bit is set
 *     [n]    DALI address byte, [n+1] DALI opcode / data byte
 *     [n+2]  answer byte, backward packets only (the query is echoed first)
 */
export const NDU_START = 0xda;
export const NDU_FORWARD = 0x08;
export const NDU_BACKWARD = 0x88;
export const DEFAULT_PORT = 62386;
export const MAX_PACKET = 600;

export interface Dali104Frame {
  /** DALI address byte of the forward frame. */
  address: number;
  /** DALI opcode / data byte. */
  opcode: number;
  /** Device type enabled for this frame (replaces ENABLE DEVICE TYPE), if any. */
  deviceType?: number;
}

export interface Dali104Packet {
  type: 'forward' | 'backward';
  /** 16-bit sequence number. */
  seq: number;
  systemAddress: number;
  frame: Dali104Frame;
  /** Present on backward packets. */
  answer?: number;
}

function adu(frame: Dali104Frame, answer?: number): Uint8Array {
  const hasDt = frame.deviceType !== undefined;
  const out = [0x01, 0x00, hasDt ? 0x80 : 0x00];
  if (hasDt) out.push(frame.deviceType! & 0x7f);
  out.push(frame.address & 0xff, frame.opcode & 0xff);
  if (answer !== undefined) out.push(answer & 0xff);
  return Uint8Array.from(out);
}

function packet(kind: number, seq: number, systemAddress: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  out[0] = NDU_START; out[1] = kind; out[2] = 0;
  out[3] = (seq >> 8) & 0xff; out[4] = seq & 0xff;
  out[5] = systemAddress & 0xff;
  out[6] = (body.length >> 8) & 0x03; out[7] = body.length & 0xff;
  out.set(body, 8);
  return out;
}

export function encodeForward(seq: number, systemAddress: number, frame: Dali104Frame): Uint8Array {
  return packet(NDU_FORWARD, seq, systemAddress, adu(frame));
}

export function encodeBackward(seq: number, systemAddress: number, frame: Dali104Frame, answer: number): Uint8Array {
  return packet(NDU_BACKWARD, seq, systemAddress, adu(frame, answer));
}

/** Parse one datagram; undefined when it is not a packet this implementation understands. */
export function decodePacket(data: Uint8Array): Dali104Packet | undefined {
  if (data.length < 8 || data[0] !== NDU_START) return undefined;
  const kind = data[1]!;
  if (kind !== NDU_FORWARD && kind !== NDU_BACKWARD) return undefined;
  if (data[2]! & 0x80) return undefined; // DTLS
  const length = (((data[6]! << 8) | data[7]!) & 0x3ff);
  if (data.length < 8 + length) return undefined;
  const a = data.subarray(8, 8 + length);
  if (a.length < 5) return undefined;
  const hasDt = !!(a[2]! & 0x80);
  const idx = 3 + (hasDt ? 1 : 0);
  if (a.length < idx + 2) return undefined;
  const frame: Dali104Frame = { address: a[idx]!, opcode: a[idx + 1]! };
  if (hasDt) frame.deviceType = a[3]! & 0x7f;
  const backward = kind === NDU_BACKWARD;
  if (backward && a.length < idx + 3) return undefined;
  return {
    type: backward ? 'backward' : 'forward',
    seq: (data[3]! << 8) | data[4]!,
    systemAddress: data[5]!,
    frame,
    answer: backward ? a[idx + 2]! : undefined
  };
}
