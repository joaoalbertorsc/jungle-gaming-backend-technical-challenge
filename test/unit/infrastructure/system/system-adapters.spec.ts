import { describe, expect, it } from 'bun:test';
import {
  NoFaults,
  NoopMetrics,
  SystemClock,
  UuidV7Generator,
} from '../../../../src/infrastructure/system/system-adapters';

describe('system adapters', () => {
  it('SystemClock reads the current time', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('UuidV7Generator hands out distinct, time-ordered UUID v7 ids', () => {
    const ids = new UuidV7Generator();
    const [a, b] = [ids.next(), ids.next()];
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('NoFaults and NoopMetrics never interfere', () => {
    const metrics = new NoopMetrics();
    expect(() => {
      new NoFaults().hit();
      metrics.transactionOutcome();
      metrics.idempotentReplay();
      metrics.lockConflict();
      metrics.reconciliationMismatch();
      metrics.duplicateMessage();
      metrics.messageRetried();
      metrics.deadLettered();
      metrics.outboxPublished();
      metrics.outboxFailed();
      metrics.referenceRetry();
    }).not.toThrow();
  });
});
