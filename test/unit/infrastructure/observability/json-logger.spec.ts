import { describe, expect, it, spyOn } from 'bun:test';
import {
  JsonLogger,
  NestJsonLogger,
} from '../../../../src/infrastructure/observability/json-logger';

function capture(level?: 'info' | 'warn' | 'debug') {
  const lines: string[] = [];
  const logger = new JsonLogger({ level, write: (line) => lines.push(line) });
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, entries };
}

/** §12: structured JSON logs, filtered by level, never carrying secrets or payloads. */
describe('JsonLogger', () => {
  it('writes one JSON line per entry with level, time, message and fields', () => {
    const { logger, entries } = capture();

    logger.info('wager transaction processed', { walletId: 'w-1', transactionId: 't-1' });
    logger.warn('b');
    logger.error('c');

    expect(entries().map((e) => [e.level, e.message])).toEqual([
      ['info', 'wager transaction processed'],
      ['warn', 'b'],
      ['error', 'c'],
    ]);
    expect(entries()[0]).toMatchObject({
      walletId: 'w-1',
      transactionId: 't-1',
      time: expect.any(String),
    });
  });

  it('writes to stdout by default', () => {
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      new JsonLogger().info('to stdout');
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ message: 'to stdout' });
    } finally {
      log.mockRestore();
    }
  });

  it('drops entries below the configured level', () => {
    const { logger, entries } = capture('warn');

    logger.debug('noise');
    logger.info('noise');
    logger.warn('kept');

    expect(entries().map((e) => e.message)).toEqual(['kept']);
  });

  it('redacts credentials and payloads, however deep, and keeps identifiers', () => {
    const { logger, lines, entries } = capture();

    logger.info('request', {
      walletId: 'w-1',
      authorization: 'Bearer secret-token',
      request: { headers: { cookie: 'session=abc' }, body: { money: { amount: '25.00' } } },
      payload: { amount: '25.00' },
    });

    expect(entries()[0]).toEqual({
      level: 'info',
      time: expect.any(String),
      message: 'request',
      walletId: 'w-1',
      authorization: '[REDACTED]',
      request: { headers: { cookie: '[REDACTED]' }, body: '[REDACTED]' },
      payload: '[REDACTED]',
    });
    expect(lines[0]).not.toContain('secret-token');
    expect(lines[0]).not.toContain('25.00');
  });

  it('serializes errors by name and message, never by their stack', () => {
    const { logger, entries } = capture();

    logger.error('failed', { error: new TypeError('boom') });

    expect(entries()[0]).toMatchObject({ error: { name: 'TypeError', message: 'boom' } });
  });
});

describe('NestJsonLogger', () => {
  it("routes Nest's own logs through the JSON logger with their context", () => {
    const { logger, entries } = capture('debug');
    const nest = new NestJsonLogger(logger);

    nest.log('roles [api] up', 'Bootstrap');
    nest.warn('slow', 'InstanceLoader');
    nest.error('crashed', 'stack trace', 'ExceptionHandler');
    nest.debug('details', 'Router');
    nest.verbose('more', 'Router');
    nest.fatal('dead', 'Bootstrap');

    expect(entries().map((e) => [e.level, e.message, e.context])).toEqual([
      ['info', 'roles [api] up', 'Bootstrap'],
      ['warn', 'slow', 'InstanceLoader'],
      ['error', 'crashed', 'ExceptionHandler'],
      ['debug', 'details', 'Router'],
      ['debug', 'more', 'Router'],
      ['error', 'dead', 'Bootstrap'],
    ]);
  });
});
