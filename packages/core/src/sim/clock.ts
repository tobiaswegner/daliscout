/**
 * Simulation clock: follows a host clock, scaled by `speed` and stoppable. Fades and timers
 * run on this clock, so the UI can slow them down (0.1x), speed them up (10x) or freeze them.
 */
export class SimClock {
  private acc = 0;
  private lastHost: number;
  private _speed = 1;
  private _paused = false;

  /** @param hostNow monotonic host time in µs */
  constructor(private readonly hostNow: () => number) {
    this.lastHost = hostNow();
  }

  get speed(): number { return this._speed; }
  get paused(): boolean { return this._paused; }

  /** Current simulation time in µs. */
  now(): number {
    const h = this.hostNow();
    if (!this._paused) this.acc += (h - this.lastHost) * this._speed;
    this.lastHost = h;
    return this.acc;
  }

  setSpeed(speed: number): void {
    if (!(speed > 0) || !Number.isFinite(speed)) throw new RangeError('speed must be a positive number');
    this.now(); // settle time elapsed at the old speed
    this._speed = speed;
  }

  pause(): void { this.now(); this._paused = true; }
  resume(): void { this.now(); this._paused = false; }
}
