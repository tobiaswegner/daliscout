import type { GearState, Times } from './types.js';

/** What a device-type extension may use from the gear that hosts it. */
export interface ExtContext {
  s: GearState;
  t: Times;
  /** Effective fade duration (µs) from the gear's fade time registers. */
  fadeUs: number;
  /** Send-twice gate for configuration commands: true when the command must run now. */
  twice(): boolean;
  changed(): void;
}

/**
 * A device-type extension (DT0, DT8...). It owns no state: everything lives in the serialisable
 * GearState, so snapshots, UI and tests need no knowledge of the extension objects.
 */
export interface GearExtension {
  readonly deviceType: number;
  /** Application extended command 0xE0-0xFF after ENABLE DEVICE TYPE; returns an answer byte. */
  command(op: number, ctx: ExtContext): number | undefined;
  /** Advance fades/timers; true when something visible changed. */
  advance?(simUs: number, s: GearState): boolean;
  /** RESET command (or reset values). */
  reset?(s: GearState): void;
  scene?(kind: 'store' | 'remove' | 'recall', n: number, ctx: ExtContext): void;
}
