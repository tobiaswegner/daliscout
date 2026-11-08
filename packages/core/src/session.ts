import type { BusFrame } from './frame.js';
import { Decoder, type Decoded } from './decoder.js';

export type AnswerStatus = 'n/a' | 'pending' | 'answered' | 'none';

export interface Row {
  seq: number;
  frame: BusFrame;
  decoded: Decoded;
  /** Microseconds since the previous frame (0 for the first). */
  deltaUs: number;
  answerStatus: AnswerStatus;
  answerSeq?: number;
}

/** Holds decoded rows for one capture and correlates answers with their queries. */
export class CaptureSession {
  private rows: Row[] = [];
  private base = 0; // seq of rows[0]
  private nextSeq = 0;
  private decoder = new Decoder();
  private lastTs?: number;
  /** Queries that were followed by another frame without a reply. */
  unanswered = 0;

  constructor(private readonly maxRows = 1_000_000) {}

  get length(): number { return this.rows.length; }
  get firstSeq(): number { return this.base; }
  at(index: number): Row | undefined { return this.rows[index]; }
  bySeq(seq: number): Row | undefined { return this.rows[seq - this.base]; }
  all(): readonly Row[] { return this.rows; }

  push(frame: BusFrame): Row {
    const seq = this.nextSeq++;
    const decoded = this.decoder.decode(frame, seq);
    const row: Row = {
      seq, frame, decoded,
      deltaUs: this.lastTs === undefined ? 0 : frame.ts - this.lastTs,
      answerStatus: decoded.expectsAnswer ? 'pending' : 'n/a'
    };
    this.lastTs = frame.ts;

    if (frame.kind !== 'backward') {
      // a non-reply frame closes every still-open query window
      const prev = this.rows[this.rows.length - 1];
      if (prev && prev.answerStatus === 'pending') { prev.answerStatus = 'none'; this.unanswered++; }
    } else if (decoded.answerTo !== undefined) {
      const q = this.bySeq(decoded.answerTo);
      if (q) {
        q.answerStatus = 'answered';
        q.answerSeq = seq;
        q.decoded.answer = decoded.summary.replace(/^→ /, '');
        decoded.addr = q.decoded.addr; // lets address filters follow a whole conversation
      }
    }

    this.rows.push(row);
    if (this.rows.length > this.maxRows) {
      const drop = this.rows.length - this.maxRows;
      this.rows.splice(0, drop);
      this.base += drop;
    }
    return row;
  }

  clear(): void {
    this.rows = [];
    this.base = this.nextSeq;
    this.decoder.reset();
    this.lastTs = undefined;
    this.unanswered = 0;
  }
}
