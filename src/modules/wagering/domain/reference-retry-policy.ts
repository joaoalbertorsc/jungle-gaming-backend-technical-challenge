import { ExponentialBackoff } from '../../../shared/domain/exponential-backoff';

export type ReferenceRetryDecision =
  { readonly type: 'retry'; readonly at: Date } | { readonly type: 'give-up' };

export interface ReferenceRetryPolicyOptions {
  /** Worker attempts before the transaction is rejected. */
  readonly maxAttempts: number;
  /** Wait before retry n: backoff.delayMs(n). */
  readonly backoff: ExponentialBackoff;
}

/**
 * When a PENDING_REFERENCE transaction is retried, and when the worker gives up on it (§7 rule 8,
 * ADR-0012). The arrival schedules retry 1; each attempt that still cannot resolve the reference
 * schedules the next one, until `maxAttempts` attempts have been made.
 */
export class ReferenceRetryPolicy {
  /** 10 attempts, 1 s doubling up to 5 min: about 13.5 minutes in total. */
  static readonly DEFAULT = new ReferenceRetryPolicy({
    maxAttempts: 10,
    backoff: new ExponentialBackoff({ baseMs: 1_000, factor: 2, maxMs: 300_000 }),
  });

  constructor(private readonly options: ReferenceRetryPolicyOptions) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be a positive integer');
    }
  }

  get maxAttempts(): number {
    return this.options.maxAttempts;
  }

  /** When retry 1 is due for a transaction parked at `now`. */
  firstRetryAt(now: Date): Date {
    return this.options.backoff.nextAttemptAt(now, 1);
  }

  /** What follows attempt number `attempt` (1-based) that still could not resolve the reference. */
  afterUnresolved(attempt: number, now: Date): ReferenceRetryDecision {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new RangeError('attempt must be a positive integer');
    }
    if (attempt >= this.options.maxAttempts) return { type: 'give-up' };
    return { type: 'retry', at: this.options.backoff.nextAttemptAt(now, attempt + 1) };
  }

  /** Time from parking to giving up when the reference never appears. */
  totalWaitMs(): number {
    let total = 0;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      total += this.options.backoff.delayMs(attempt);
    }
    return total;
  }
}
