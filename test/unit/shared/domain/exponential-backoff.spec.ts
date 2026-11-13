import { describe, expect, it } from 'bun:test';
import { ExponentialBackoff } from '../../../../src/shared/domain/exponential-backoff';

describe('ExponentialBackoff', () => {
  const backoff = new ExponentialBackoff({ baseMs: 1_000, factor: 2, maxMs: 300_000 });

  it('waits the base delay before the first retry', () => {
    expect(backoff.delayMs(1)).toBe(1_000);
  });

  it('multiplies the delay by the factor on each attempt', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => backoff.delayMs(attempt))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
  });

  it('never exceeds the maximum delay', () => {
    expect(backoff.delayMs(10)).toBe(300_000);
    expect(backoff.delayMs(60)).toBe(300_000);
  });

  it('computes the next attempt time from now', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    expect(backoff.nextAttemptAt(now, 3).toISOString()).toBe('2026-01-01T00:00:04.000Z');
  });

  it.each([0, -1, 1.5])('rejects the attempt number %p', (attempt) => {
    expect(() => backoff.delayMs(attempt)).toThrow(RangeError);
  });

  it.each([
    [{ baseMs: 0, factor: 2, maxMs: 10 }],
    [{ baseMs: 10, factor: 0.5, maxMs: 100 }],
    [{ baseMs: 100, factor: 2, maxMs: 10 }],
  ])('rejects inconsistent options %p', (options) => {
    expect(() => new ExponentialBackoff(options)).toThrow(RangeError);
  });
});
