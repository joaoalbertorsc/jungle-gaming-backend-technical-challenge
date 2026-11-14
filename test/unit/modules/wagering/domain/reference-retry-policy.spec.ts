import { describe, expect, it } from 'bun:test';
import { ReferenceRetryPolicy } from '../../../../../src/modules/wagering/domain/reference-retry-policy';
import { ExponentialBackoff } from '../../../../../src/shared/domain/exponential-backoff';

const now = new Date('2026-01-01T00:00:00.000Z');
const plus = (ms: number) => new Date(now.getTime() + ms).toISOString();

/** ADR-0012: 10 attempts, 1 s doubling up to 5 min, then REFERENCE_NOT_FOUND. */
describe('ReferenceRetryPolicy', () => {
  const policy = ReferenceRetryPolicy.DEFAULT;

  it('schedules the first retry one second after the transaction is parked', () => {
    expect(policy.firstRetryAt(now).toISOString()).toBe(plus(1_000));
  });

  it('doubles the wait after each attempt that still finds no reference', () => {
    const waits = [1, 2, 3, 4].map((attempt) => {
      const decision = policy.afterUnresolved(attempt, now);
      return decision.type === 'retry' ? decision.at.toISOString() : decision.type;
    });

    expect(waits).toEqual([plus(2_000), plus(4_000), plus(8_000), plus(16_000)]);
  });

  it('never waits more than five minutes between attempts', () => {
    expect(policy.afterUnresolved(9, now)).toEqual({ type: 'retry', at: new Date(plus(300_000)) });
  });

  it('gives up after the tenth attempt', () => {
    expect(policy.maxAttempts).toBe(10);
    expect(policy.afterUnresolved(10, now)).toEqual({ type: 'give-up' });
    expect(policy.afterUnresolved(11, now)).toEqual({ type: 'give-up' });
  });

  it('waits about 13 minutes in total before giving up', () => {
    // 1 + 2 + 4 + ... + 256 s, then the capped 300 s wait before the tenth attempt.
    expect(policy.totalWaitMs()).toBe(811_000);
  });

  it('honours a configured limit and backoff', () => {
    const quick = new ReferenceRetryPolicy({
      maxAttempts: 2,
      backoff: new ExponentialBackoff({ baseMs: 10, factor: 3, maxMs: 1_000 }),
    });

    expect(quick.firstRetryAt(now).toISOString()).toBe(plus(10));
    expect(quick.afterUnresolved(1, now)).toEqual({ type: 'retry', at: new Date(plus(30)) });
    expect(quick.afterUnresolved(2, now)).toEqual({ type: 'give-up' });
  });

  it.each([0, -1, 1.5])('rejects a limit of %p attempts', (maxAttempts) => {
    expect(
      () =>
        new ReferenceRetryPolicy({
          maxAttempts,
          backoff: new ExponentialBackoff({ baseMs: 1, factor: 1, maxMs: 1 }),
        }),
    ).toThrow(RangeError);
  });

  it.each([0, -1, 1.5])('rejects the attempt number %p', (attempt) => {
    expect(() => policy.afterUnresolved(attempt, now)).toThrow(RangeError);
  });
});
