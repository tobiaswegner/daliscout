import table from '../data/commands-ext.json';
import type { AnswerKind } from './commands.js';

export interface ExtCommandDef {
  code: number;
  name: string;
  sendTwice?: boolean;
  answer?: AnswerKind;
  /** Name of the parameter formatter, see describeExtParams. */
  fmt?: string;
}

const byType = new Map<number, Map<number, ExtCommandDef>>();
for (const [k, defs] of Object.entries(table)) {
  if (k.startsWith('_')) continue;
  byType.set(Number(k), new Map((defs as ExtCommandDef[]).map((d) => [d.code, d])));
}

export function lookupExtended(deviceType: number, op: number): ExtCommandDef | undefined {
  return byType.get(deviceType)?.get(op);
}

export function hasExtendedTable(deviceType: number): boolean {
  return byType.has(deviceType);
}

export interface DtrValues { dtr0?: number; dtr1?: number; dtr2?: number }

const hex16 = (v: number) => '0x' + v.toString(16).padStart(4, '0').toUpperCase();

const COLOUR_SELECTORS: [number, number, string][] = [
  [0, 0, 'X'], [1, 1, 'Y'], [2, 2, 'Tc'], [3, 8, 'primary'], [64, 69, 'RGBWAF channel'], [70, 70, 'RGBWAF control']
];

function selectorName(sel: number): string {
  const bank = sel >= 192 ? 'report' : sel >= 128 ? 'temporary' : 'actual';
  const base = sel >= 192 ? sel - 192 : sel >= 128 ? sel - 128 : sel;
  for (const [lo, hi, name] of COLOUR_SELECTORS) {
    if (base >= lo && base <= hi) return `${bank} ${name}${hi > lo ? ' ' + (base - lo) : ''}`;
  }
  return `unknown selector ${sel}`;
}

/** Human-readable parameters of a DT0/DT8 extended command, using the tracked DTR contents. */
export function describeExtParams(def: ExtCommandDef, r: DtrValues): string[] {
  const { dtr0: d0, dtr1: d1, dtr2: d2 } = r;
  const w = d0 !== undefined && d1 !== undefined ? (d1 << 8) | d0 : undefined;
  const unknown = ['DTR=?'];
  switch (def.fmt) {
    case 'x': case 'y':
      return w === undefined ? unknown : w === 0xffff ? ['MASK'] : [`${def.fmt}=${(w / 65536).toFixed(4)} (${hex16(w)})`];
    case 'tc':
      return w === undefined ? unknown : w === 0xffff ? ['MASK'] : [`${w} mirek = ${Math.round(1e6 / Math.max(w, 1))} K`];
    case 'primary':
      return w === undefined || d2 === undefined ? unknown
        : [`primary ${d2 === 255 ? 'ALL' : d2}`, w === 0xffff ? 'MASK' : `${((w / 65534) * 100).toFixed(1)} %`];
    case 'rgb':
      return d0 === undefined || d1 === undefined || d2 === undefined ? unknown : [`R=${d0}`, `G=${d1}`, `B=${d2}`];
    case 'waf':
      return d0 === undefined || d1 === undefined || d2 === undefined ? unknown : [`W=${d0}`, `A=${d1}`, `F=${d2}`];
    case 'control':
      return d0 === undefined ? unknown : [`control=${d0.toString(2).padStart(8, '0')}b`];
    case 'primaryTy': case 'primaryN':
      return d2 === undefined ? unknown : [`primary ${d2}`];
    case 'tcLimit':
      return w === undefined || d2 === undefined ? unknown
        : [d2 === 0 ? 'coolest' : d2 === 1 ? 'warmest' : `limit ${d2}`, `${w} mirek = ${Math.round(1e6 / Math.max(w, 1))} K`];
    case 'assign':
      return d0 === undefined || d2 === undefined ? unknown : [`channel ${d2}`, `colour ${d0}`];
    case 'colourSelector':
      return d0 === undefined ? unknown : [selectorName(d0)];
    case 'curve':
      return d0 === undefined ? unknown : [d0 === 0 ? 'standard (logarithmic)' : d0 === 1 ? 'linear' : `invalid ${d0}`];
    case 'fast':
      return d0 === undefined ? unknown : [d0 === 0 ? 'off' : `${d0 * 25} ms`];
    default:
      return [];
  }
}

export function formatColourStatus(b: number): string {
  const bits: [number, string][] = [
    [1, 'xy out of range'], [2, 'Tc out of range'], [4, 'auto calibration running'], [8, 'auto calibration successful'],
    [16, 'xy active'], [32, 'Tc active'], [64, 'primary N active'], [128, 'RGBWAF active']
  ];
  const set = bits.filter(([m]) => b & m).map(([, n]) => n);
  return `0x${b.toString(16).padStart(2, '0').toUpperCase()} (${set.join(', ') || 'none'})`;
}

export function formatColourFeatures(b: number): string {
  const parts: string[] = [];
  if (b & 1) parts.push('xy');
  if (b & 2) parts.push('Tc');
  if ((b >> 2) & 7) parts.push(`${(b >> 2) & 7} primaries`);
  if ((b >> 5) & 7) parts.push(`${(b >> 5) & 7} RGBWAF channels`);
  return parts.join(', ') || 'none';
}
