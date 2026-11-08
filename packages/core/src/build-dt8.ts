import { buildCommand, buildSpecial, type TargetSpec } from './build.js';

/** One frame of a scripted sequence. */
export interface SeqFrame { data: Uint8Array; sendTwice?: boolean }

const dtr = (r0: number, r1?: number, r2?: number): SeqFrame[] => [
  { data: buildSpecial(0xa3, r0 & 255) },
  ...(r1 === undefined ? [] : [{ data: buildSpecial(0xc3, r1 & 255) }]),
  ...(r2 === undefined ? [] : [{ data: buildSpecial(0xc5, r2 & 255) }])
];
const ext = (t: TargetSpec, dt: number, op: number, sendTwice = false): SeqFrame[] =>
  Array.from({ length: sendTwice ? 2 : 1 }, () => [
    { data: buildSpecial(0xc1, dt) }, { data: buildCommand(t, op) }
  ]).flat();

export const DT8_OP = {
  setX: 0xe0, setY: 0xe1, activate: 0xe2, setTc: 0xe7, setPrimary: 0xea, setRgb: 0xeb, setWaf: 0xec,
  setControl: 0xed, queryFeatures: 0xf9, queryColourStatus: 0xf8, queryColourValue: 0xfa
} as const;

/** DTR1:DTR0 = x, y; SET TEMPORARY X / Y; ACTIVATE. Coordinates are 0..1. */
export function seqSetXy(t: TargetSpec, x: number, y: number): SeqFrame[] {
  const X = Math.min(0xfffe, Math.round(x * 65536)), Y = Math.min(0xfffe, Math.round(y * 65536));
  return [
    ...dtr(X & 255, X >> 8), ...ext(t, 8, DT8_OP.setX),
    ...dtr(Y & 255, Y >> 8), ...ext(t, 8, DT8_OP.setY),
    ...ext(t, 8, DT8_OP.activate)
  ];
}

/** Colour temperature in mirek. */
export function seqSetTc(t: TargetSpec, mirek: number): SeqFrame[] {
  const v = Math.min(0xfffe, Math.max(0, Math.round(mirek)));
  return [...dtr(v & 255, v >> 8), ...ext(t, 8, DT8_OP.setTc), ...ext(t, 8, DT8_OP.activate)];
}

/** 8-bit levels 0..254 (255 = MASK, leaves the channel unchanged). */
export function seqSetRgb(t: TargetSpec, r: number, g: number, b: number): SeqFrame[] {
  return [...dtr(r, g, b), ...ext(t, 8, DT8_OP.setRgb), ...ext(t, 8, DT8_OP.activate)];
}

export function seqSetWaf(t: TargetSpec, w: number, a: number, f: number): SeqFrame[] {
  return [...dtr(w, a, f), ...ext(t, 8, DT8_OP.setWaf), ...ext(t, 8, DT8_OP.activate)];
}

/** Convert a CSS-style 0..255 channel to a DALI 8-bit level (0..254). */
export const channelToLevel = (c: number): number => Math.min(254, Math.max(0, Math.round((c / 255) * 254)));
