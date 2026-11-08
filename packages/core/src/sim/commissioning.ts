/**
 * Controller-side DALI commissioning (binary search over the 24-bit random address), used to
 * test the gear simulation and as a built-in "commission bus" action. It speaks only through
 * the abstract `CommissioningIo`, so it works against a Simulation directly or over a bus.
 */
export interface CommissioningIo {
  /** Send a 16-bit special/standard frame. `twice` = send twice within 100 ms. */
  send(frame: [number, number], twice?: boolean): void | Promise<void>;
  /** Send a frame and report the answer byte, or null when nobody answered. */
  query(frame: [number, number]): number | null | Promise<number | null>;
}

export interface CommissioningOptions {
  /** Re-address every gear (INITIALISE 0x00) instead of only unaddressed ones (0xFF). */
  all?: boolean;
  /** First short address to assign. */
  firstAddress?: number;
  /** Stop after this many addresses (DALI allows 64). */
  maxAddresses?: number;
}

export interface CommissioningResult {
  /** Number of gears that received an address. */
  assigned: number;
  /** Frames sent, for diagnostics. */
  frames: number;
}

export async function commissionBus(io: CommissioningIo, opts: CommissioningOptions = {}): Promise<CommissioningResult> {
  let frames = 0;
  const send = async (f: [number, number], twice = false) => { frames += twice ? 2 : 1; await io.send(f, twice); };
  const query = async (f: [number, number]) => { frames++; return io.query(f); };

  let lastH = -1, lastM = -1, lastL = -1;
  const setSearch = async (v: number) => {
    const h = (v >> 16) & 0xff, m = (v >> 8) & 0xff, l = v & 0xff;
    if (h !== lastH) { await send([0xb1, h]); lastH = h; }
    if (m !== lastM) { await send([0xb3, m]); lastM = m; }
    if (l !== lastL) { await send([0xb5, l]); lastL = l; }
  };
  const compare = async () => (await query([0xa9, 0x00])) !== null;

  const first = opts.firstAddress ?? 0;
  const maxAddr = opts.maxAddresses ?? 64;
  let assigned = 0;

  await send([0xa5, opts.all ? 0x00 : 0xff], true); // INITIALISE
  await send([0xa7, 0x00], true);                    // RANDOMISE

  while (first + assigned < Math.min(64, first + maxAddr)) {
    await setSearch(0xffffff);
    if (!(await compare())) break; // nobody left
    let lo = 0, hi = 0xffffff;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      await setSearch(mid);
      if (await compare()) hi = mid; else lo = mid + 1;
    }
    await setSearch(lo);
    const short = first + assigned;
    await send([0xb7, (short << 1) | 1]);           // PROGRAM SHORT ADDRESS
    const ok = await query([0xb9, (short << 1) | 1]); // VERIFY SHORT ADDRESS
    await send([0xab, 0x00]);                         // WITHDRAW
    if (ok !== null) assigned++;
  }
  await send([0xa1, 0x00]);                           // TERMINATE
  return { assigned, frames };
}
