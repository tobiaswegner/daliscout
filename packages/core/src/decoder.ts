import type { BusFrame } from './frame.js';
import { toHex } from './frame.js';
import { lookupCommand, lookupSpecial, type AnswerKind, type CommandDef } from './commands.js';
import { formatLevel, MASK } from './level.js';

export type DecodedClass =
  | 'arc' | 'config' | 'query' | 'special' | 'extended'
  | 'control-device' | 'answer' | 'error' | 'unknown';

export interface Decoded {
  layer: '102' | '103' | 'raw';
  class: DecodedClass;
  /** One-line human-readable description. */
  summary: string;
  /** e.g. "Short 5", "Group 3", "Broadcast", "Special". */
  target: string;
  command: string;
  params: string[];
  /** Filled in for queries once the reply has been seen. */
  answer?: string;
  /** For backward frames: sequence number of the query being answered. */
  answerTo?: number;
  expectsAnswer: boolean;
  sendTwice: boolean;
  unknown: boolean;
  warnings: string[];
}

interface Pending {
  seq: number;
  def: CommandDef;
  kind: AnswerKind;
}

const DEVICE_TYPES: Record<number, string> = {
  0: 'DT0 fluorescent lamp', 1: 'DT1 emergency lighting', 2: 'DT2 discharge lamp',
  3: 'DT3 low-voltage halogen', 4: 'DT4 incandescent', 5: 'DT5 DC converter',
  6: 'DT6 LED', 7: 'DT7 relay', 8: 'DT8 colour control',
  254: 'multiple device types', 255: 'no (further) device type'
};

const STATUS_BITS = [
  'control gear failure', 'lamp failure', 'lamp arc power on', 'limit error',
  'fade running', 'reset state', 'missing short address', 'power failure'
];

const hexByte = (n: number) => '0x' + n.toString(16).padStart(2, '0').toUpperCase();

/**
 * Stateful decoder: tracks DTR0-2, ENABLE DEVICE TYPE and the outstanding query so
 * frames can be explained in context. Feed frames in capture order.
 */
export class Decoder {
  dtr0?: number;
  dtr1?: number;
  dtr2?: number;
  private enableDT?: number;
  private pending?: Pending;

  reset(): void {
    this.dtr0 = this.dtr1 = this.dtr2 = this.enableDT = undefined;
    this.pending = undefined;
  }

  decode(frame: BusFrame, seq = 0): Decoded {
    if (frame.kind === 'error') return this.decodeError(frame);
    if (frame.bits === 8 && frame.data.length === 1) return this.decodeBackward(frame.data[0]!, seq);
    if (frame.bits === 16 && frame.data.length === 2) {
      this.pending = undefined; // a new forward frame ends any open query window
      return this.decodeForward16(frame.data[0]!, frame.data[1]!, seq);
    }
    this.pending = undefined;
    if (frame.bits === 24 && frame.data.length === 3) return this.decodeControlDevice(frame.data);
    return base({
      layer: 'raw', class: 'unknown', unknown: true,
      summary: `${frame.bits}-bit frame ${toHex(frame.data)}`,
      command: 'UNKNOWN FRAME',
      warnings: [`Unsupported frame length (${frame.bits} bits)`]
    });
  }

  private decodeError(frame: BusFrame): Decoded {
    this.pending = undefined;
    const why = frame.error ?? 'unknown';
    return base({
      layer: 'raw', class: 'error', unknown: true, command: 'BUS ERROR',
      summary: `Bus error: ${why}${frame.data.length ? ' ' + toHex(frame.data) : ''}`,
      warnings: [`${why} error`]
    });
  }

  private decodeBackward(b: number, _seq: number): Decoded {
    const p = this.pending;
    this.pending = undefined;
    if (!p) {
      return base({
        layer: '102', class: 'answer', command: 'BACKWARD FRAME', target: 'Gear',
        summary: `Backward frame ${hexByte(b)} (no matching query)`,
        params: [hexByte(b)], warnings: ['Reply without a preceding query']
      });
    }
    const text = this.formatAnswer(p.kind, b);
    return base({
      layer: '102', class: 'answer', command: 'ANSWER', target: 'Gear',
      summary: `→ ${text}`, params: [hexByte(b)], answerTo: p.seq
    });
  }

  private formatAnswer(kind: AnswerKind, b: number): string {
    switch (kind) {
      case 'yes-no': return b === 0xff ? 'YES' : `${hexByte(b)} (unexpected for yes/no)`;
      case 'level': return formatLevel(b);
      case 'device-type': return DEVICE_TYPES[b] ?? `device type ${b}`;
      case 'short-address':
        return b === 0xff ? 'no short address' : `short address ${(b >> 1) & 0x3f}`;
      case 'fade':
        return `fade time ${b >> 4}, fade rate ${b & 0x0f}`;
      case 'bitmask': {
        const groups: number[] = [];
        for (let i = 0; i < 8; i++) if (b & (1 << i)) groups.push(i);
        return `${hexByte(b)} (bits ${groups.join(',') || 'none'})`;
      }
      case 'status': {
        const set = STATUS_BITS.filter((_, i) => b & (1 << i));
        return `${hexByte(b)} (${set.join(', ') || 'all clear'})`;
      }
      default: return `${b} (${hexByte(b)})`;
    }
  }

  private decodeForward16(a: number, d: number, seq: number): Decoded {
    const enableDT = this.enableDT;
    // ENABLE DEVICE TYPE applies to the next frame only (not to further ENABLE DT frames)
    if (a !== 0xc1) this.enableDT = undefined;

    // Special commands live in the address-byte range 0xA0..0xFB, which is no valid address.
    if (a >= 0xa0 && a <= 0xfb) return this.decodeSpecial(a, d, seq);

    let target: string;
    let selector: boolean; // S bit
    selector = (a & 1) === 1;
    if ((a & 0x80) === 0) target = `Short ${(a >> 1) & 0x3f}`;
    else if ((a & 0xe0) === 0x80) target = `Group ${(a >> 1) & 0x0f}`;
    else if (a >= 0xfe) target = 'Broadcast';
    else target = 'Broadcast unaddressed';

    if (!selector) {
      // Direct arc power control
      const lvl = formatLevel(d);
      return base({
        layer: '102', class: 'arc', target, command: 'DAPC',
        params: [lvl], summary: `${target} · DAPC ${d === MASK ? 'MASK (stop fade)' : lvl}`
      });
    }
    return this.decodeCommand(target, d, seq, enableDT);
  }

  private decodeCommand(target: string, op: number, seq: number, enableDT?: number): Decoded {
    if (op >= 0xe0 && enableDT !== undefined) {
      const dt = DEVICE_TYPES[enableDT]?.split(' ')[0] ?? `DT${enableDT}`;
      return base({
        layer: '102', class: 'extended', target, command: `${dt} EXTENDED COMMAND`,
        params: [hexByte(op)], summary: `${target} · ${dt} extended command ${hexByte(op)}`
      });
    }
    const hit = lookupCommand(op);
    if (!hit) {
      const warn = op >= 0xe0
        ? 'Application extended command without preceding ENABLE DEVICE TYPE'
        : 'Unknown/reserved command';
      return base({
        layer: '102', class: 'unknown', unknown: true, target, command: 'UNKNOWN COMMAND',
        params: [hexByte(op)], summary: `${target} · unknown command ${hexByte(op)}`, warnings: [warn]
      });
    }
    const { def, offset } = hit;
    const params: string[] = [];
    const name = def.param ? `${def.name} ${offset}` : def.name;
    if (def.dtr0) {
      if (this.dtr0 === undefined) params.push('DTR0=?');
      else params.push(`DTR0=${def.level ? formatLevel(this.dtr0) : this.dtr0}`);
    }
    if (def.name === 'STORE ACTUAL LEVEL IN DTR0') this.dtr0 = undefined;
    const cls: DecodedClass = def.answer ? 'query' : op >= 0x20 ? 'config' : 'arc';
    if (def.answer) this.pending = { seq, def, kind: def.answer };
    return base({
      layer: '102', class: cls, target, command: name, params,
      expectsAnswer: !!def.answer, sendTwice: !!def.sendTwice,
      summary: `${target} · ${name}${params.length ? ' (' + params.join(', ') + ')' : ''}`
    });
  }

  private decodeSpecial(a: number, d: number, seq: number): Decoded {
    const hit = lookupSpecial(a);
    if (!hit) {
      return base({
        layer: '102', class: 'unknown', unknown: true, target: 'Special',
        command: 'UNKNOWN SPECIAL', params: [hexByte(a), hexByte(d)],
        summary: `Special · unknown ${hexByte(a)} ${hexByte(d)}`,
        warnings: ['Unknown/reserved special command']
      });
    }
    const def = hit.def;
    const params: string[] = [];
    switch (def.data) {
      case 'dtr0': this.dtr0 = d; params.push(`${d} (${hexByte(d)})`); break;
      case 'dtr1': this.dtr1 = d; params.push(`${d} (${hexByte(d)})`); break;
      case 'dtr2': this.dtr2 = d; params.push(`${d} (${hexByte(d)})`); break;
      case 'byte': params.push(`${d} (${hexByte(d)})`); break;
      case 'device-type':
        this.enableDT = d;
        params.push(DEVICE_TYPES[d] ?? `type ${d}`);
        break;
      case 'initialise':
        params.push(d === 0 ? 'all gear' : d === 0xff ? 'unaddressed gear only'
          : (d & 0x81) === 0x01 ? `short address ${(d >> 1) & 0x3f}` : `invalid (${hexByte(d)})`);
        break;
      case 'short-address':
        params.push(d === 0xff ? 'delete short address' : `short address ${(d >> 1) & 0x3f}`);
        break;
    }
    if (def.answer) this.pending = { seq, def, kind: def.answer };
    return base({
      layer: '102', class: 'special', target: 'Special', command: def.name, params,
      expectsAnswer: !!def.answer, sendTwice: !!def.sendTwice,
      summary: `Special · ${def.name}${params.length ? ' ' + params.join(', ') : ''}`
    });
  }

  private decodeControlDevice(data: Uint8Array): Decoded {
    const [a, inst, op] = data as unknown as [number, number, number];
    return base({
      layer: '103', class: 'control-device', target: `Device ${hexByte(a)}`,
      command: 'CONTROL DEVICE FRAME', unknown: true,
      params: [`instance ${hexByte(inst)}`, `opcode ${hexByte(op)}`],
      summary: `24-bit control device frame: addr ${hexByte(a)}, instance ${hexByte(inst)}, opcode ${hexByte(op)}`,
      warnings: ['IEC 62386-103 decoding not implemented yet; shown raw']
    });
  }
}

function base(p: Partial<Decoded> & Pick<Decoded, 'layer' | 'class' | 'summary' | 'command'>): Decoded {
  return {
    target: '', params: [], expectsAnswer: false, sendTwice: false,
    unknown: false, warnings: [], ...p
  };
}
