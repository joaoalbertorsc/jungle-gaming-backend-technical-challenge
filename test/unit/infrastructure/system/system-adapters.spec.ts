import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  JsonConsoleLogger,
  NoFaults,
  NoopMetrics,
  SystemClock,
  UuidV7Generator,
} from '../../../../src/infrastructure/system/system-adapters';

describe('system adapters', () => {
  afterEach(() => {
    spyOn(console, 'log').mockRestore();
  });

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

  it('JsonConsoleLogger writes one JSON line per entry with level, message and fields', () => {
    const lines: string[] = [];
    spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    const logger = new JsonConsoleLogger();

    logger.info('a', { walletId: 'w-1' });
    logger.warn('b');
    logger.error('c');

    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.map((e) => [e.level, e.message])).toEqual([
      ['info', 'a'],
      ['warn', 'b'],
      ['error', 'c'],
    ]);
    expect(entries[0]).toMatchObject({ walletId: 'w-1', time: expect.any(String) });
  });
});
