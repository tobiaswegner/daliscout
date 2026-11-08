import { fromHex } from './frame.js';

export type TargetSpec =
  | { kind: 'short'; value: number }
  | { kind: 'group'; value: number }
  | { kind: 'broadcast' }
  | { kind: 'broadcast-unaddressed' };

function range(name: string, v: number, max: number): void {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new RangeError(`${name} must be 0..${max}, got ${v}`);
}

/** Address byte; `selector` is the S bit (false = direct arc power, true = command). */
export function encodeAddressByte(t: TargetSpec, selector: boolean): number {
  const s = selector ? 1 : 0;
  switch (t.kind) {
    case 'short': range('short address', t.value, 63); return (t.value << 1) | s;
    case 'group': range('group', t.value, 15); return 0x80 | (t.value << 1) | s;
    case 'broadcast': return 0xfe | s;
    case 'broadcast-unaddressed': return 0xfc | s;
  }
}

export function buildDapc(t: TargetSpec, level: number): Uint8Array {
  range('level', level, 255);
  return Uint8Array.of(encodeAddressByte(t, false), level);
}

export function buildCommand(t: TargetSpec, opcode: number): Uint8Array {
  range('opcode', opcode, 255);
  return Uint8Array.of(encodeAddressByte(t, true), opcode);
}

/** Special command (address byte 0xA1..0xC9) with its data byte. */
export function buildSpecial(addrByte: number, data = 0): Uint8Array {
  range('special command', addrByte, 255);
  range('data', data, 255);
  return Uint8Array.of(addrByte, data);
}

/** Parse user-entered hex ("FF 90", "ff90", "0xFF,0x90"). */
export function parseHexInput(text: string): Uint8Array {
  return fromHex(text.replace(/0x/gi, ' '));
}
