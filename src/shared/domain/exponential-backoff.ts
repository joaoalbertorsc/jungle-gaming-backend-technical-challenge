export interface ExponentialBackoffOptions {
  /** Delay before the first retry. */
  readonly baseMs: number;
  /** Growth per attempt (>= 1). */
  readonly factor: number;
  /** Upper bound for any single delay. */
  readonly maxMs: number;
}

/**
 * Deterministic exponential backoff shared by the outbox relay, the pending-reference worker and
 * SQS visibility retries: delay(n) = min(base × factor^(n−1), max).
 */
export class ExponentialBackoff {
  constructor(private readonly options: ExponentialBackoffOptions) {
    const { baseMs, factor, maxMs } = options;
    if (!(baseMs > 0) || !(factor >= 1) || !(maxMs >= baseMs)) {
      throw new RangeError('backoff requires baseMs > 0, factor >= 1 and maxMs >= baseMs');
    }
  }

  /** Delay before retry number `attempt` (1-based). */
  delayMs(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new RangeError('attempt must be a positive integer');
    }
    const { baseMs, factor, maxMs } = this.options;
    return Math.min(baseMs * factor ** (attempt - 1), maxMs);
  }

  nextAttemptAt(now: Date, attempt: number): Date {
    return new Date(now.getTime() + this.delayMs(attempt));
  }
}
