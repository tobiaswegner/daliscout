import table from '../data/commands-102.json';

export type AnswerKind =
  | 'yes-no' | 'byte' | 'level' | 'status' | 'device-type' | 'fade' | 'bitmask' | 'short-address';

export interface CommandDef {
  code: number;
  range?: number;
  name: string;
  param?: string;
  sendTwice?: boolean;
  dtr0?: boolean;
  level?: boolean;
  answer?: AnswerKind;
  data?: string;
}

const commands = table.commands as CommandDef[];
const special = table.special as CommandDef[];

function build(defs: CommandDef[]): Map<number, { def: CommandDef; offset: number }> {
  const map = new Map<number, { def: CommandDef; offset: number }>();
  for (const def of defs) {
    for (let i = 0; i < (def.range ?? 1); i++) map.set(def.code + i, { def, offset: i });
  }
  return map;
}

const commandMap = build(commands);
const specialMap = build(special);

/** Standard (S=1) command lookup, opcode 0x00-0xC5. */
export const lookupCommand = (opcode: number) => commandMap.get(opcode);
/** Special command lookup by address byte (0xA1-0xC9). */
export const lookupSpecial = (addrByte: number) => specialMap.get(addrByte);
export const allCommands = commands;
export const allSpecial = special;
