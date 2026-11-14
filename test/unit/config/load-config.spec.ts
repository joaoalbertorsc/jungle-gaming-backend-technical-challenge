import { describe, expect, it } from 'bun:test';
import { ConfigValidationError, loadConfig } from '../../../src/config/load-config';

const minimalEnv = {
  DATABASE_URL: 'postgresql://app:secret@localhost:5432/wagering',
  AWS_REGION: 'us-east-1',
};

describe('loadConfig', () => {
  describe('defaults', () => {
    it('runs only the api role when APP_ROLES is not set', () => {
      expect(loadConfig(minimalEnv).roles).toEqual(['api']);
    });

    it('listens on port 3000 and logs at info level by default', () => {
      const config = loadConfig(minimalEnv);

      expect(config.http.port).toBe(3000);
      expect(config.logLevel).toBe('info');
    });

    it('bounds database waits: pool of 10 and a 2 s wallet lock timeout', () => {
      expect(loadConfig(minimalEnv).database).toEqual({
        url: minimalEnv.DATABASE_URL,
        poolMax: 10,
        lockTimeoutMs: 2000,
      });
    });

    it('accepts database tuning overrides and rejects nonsense', () => {
      const tuned = loadConfig({ ...minimalEnv, DB_POOL_MAX: '25', DB_LOCK_TIMEOUT_MS: '250' });

      expect(tuned.database).toMatchObject({ poolMax: 25, lockTimeoutMs: 250 });
      expect(() => loadConfig({ ...minimalEnv, DB_LOCK_TIMEOUT_MS: '0' })).toThrow(
        ConfigValidationError,
      );
      expect(() => loadConfig({ ...minimalEnv, DB_POOL_MAX: '-1' })).toThrow(ConfigValidationError);
    });

    it('tunes the consumer for production by default (20 s long poll, 10 per batch)', () => {
      expect(loadConfig(minimalEnv).sqs.consumer).toEqual({
        waitTimeSeconds: 20,
        maxMessages: 10,
        drainTimeoutMs: 15_000,
        retryBaseMs: 1_000,
        retryMaxMs: 60_000,
      });
    });

    it('rejects consumer settings SQS does not allow', () => {
      expect(() => loadConfig({ ...minimalEnv, SQS_WAIT_TIME_SECONDS: '21' })).toThrow(
        ConfigValidationError,
      );
      expect(() => loadConfig({ ...minimalEnv, SQS_MAX_MESSAGES: '11' })).toThrow(
        ConfigValidationError,
      );
    });

    it('tunes the outbox relay by default (batches of 50, 30 s lease)', () => {
      expect(loadConfig(minimalEnv).outbox).toEqual({
        batchSize: 50,
        leaseMs: 30_000,
        pollIntervalMs: 500,
        retryBaseMs: 1_000,
        retryMaxMs: 300_000,
      });
    });

    it('retries pending references as ADR-0012 sets out (10 attempts, 1 s doubling to 5 min)', () => {
      expect(loadConfig(minimalEnv).referenceRetry).toEqual({
        batchSize: 50,
        leaseMs: 30_000,
        pollIntervalMs: 500,
        baseMs: 1_000,
        maxMs: 300_000,
        maxAttempts: 10,
      });
    });

    it('never lets the retry cap fall below its base delay', () => {
      const config = loadConfig({
        ...minimalEnv,
        REFERENCE_RETRY_BASE_MS: '5000',
        REFERENCE_RETRY_MAX_MS: '1000',
        REFERENCE_RETRY_MAX_ATTEMPTS: '3',
      });

      expect(config.referenceRetry).toMatchObject({ baseMs: 5_000, maxMs: 5_000, maxAttempts: 3 });
    });

    it('uses the queue names defined by the challenge', () => {
      expect(loadConfig(minimalEnv).sqs.queues).toEqual({
        wagerTransactions: 'wager-transactions.fifo',
        wagerTransactionsDlq: 'wager-transactions-dlq.fifo',
        wageringEvents: 'wagering-events.fifo',
      });
    });

    it('leaves the SQS endpoint undefined so the AWS SDK resolves the real one', () => {
      expect(loadConfig(minimalEnv).sqs.endpoint).toBeUndefined();
    });
  });

  describe('fault injection (ADR-0017)', () => {
    it('injects no fault by default', () => {
      expect(loadConfig(minimalEnv).faults).toEqual({ crashAt: undefined });
    });

    it('crashes at a named point when asked to under NODE_ENV=test', () => {
      const config = loadConfig({
        ...minimalEnv,
        NODE_ENV: 'test',
        FAULT_CRASH_AT: 'consumer.before-ack',
      });

      expect(config.faults).toEqual({ crashAt: 'consumer.before-ack' });
    });

    it.each([undefined, 'production', 'development'])(
      'refuses fault injection when NODE_ENV is %p',
      (nodeEnv) => {
        expect(() =>
          loadConfig({ ...minimalEnv, NODE_ENV: nodeEnv, FAULT_CRASH_AT: 'consumer.before-ack' }),
        ).toThrow(ConfigValidationError);
      },
    );

    it('rejects an unknown fault point', () => {
      expect(() =>
        loadConfig({ ...minimalEnv, NODE_ENV: 'test', FAULT_CRASH_AT: 'somewhere' }),
      ).toThrow(ConfigValidationError);
    });
  });

  describe('APP_ROLES', () => {
    it('parses a comma-separated list, trimming spaces and dropping duplicates', () => {
      const config = loadConfig({ ...minimalEnv, APP_ROLES: ' api, consumer ,api,outbox-relay' });

      expect(config.roles).toEqual(['api', 'consumer', 'outbox-relay']);
    });

    it('accepts every role a process can run', () => {
      const config = loadConfig({
        ...minimalEnv,
        APP_ROLES: 'api,consumer,outbox-relay,retry-worker',
      });

      expect(config.roles).toEqual(['api', 'consumer', 'outbox-relay', 'retry-worker']);
    });

    it('rejects an unknown role', () => {
      expect(() => loadConfig({ ...minimalEnv, APP_ROLES: 'api,cron' })).toThrow(
        ConfigValidationError,
      );
    });

    it('rejects an empty list', () => {
      expect(() => loadConfig({ ...minimalEnv, APP_ROLES: ' , ' })).toThrow(ConfigValidationError);
    });
  });

  describe('HTTP_PORT', () => {
    it('coerces a numeric string', () => {
      expect(loadConfig({ ...minimalEnv, HTTP_PORT: '8080' }).http.port).toBe(8080);
    });

    it.each(['0', '65536', 'abc', '80.5'])('rejects %p', (port) => {
      expect(() => loadConfig({ ...minimalEnv, HTTP_PORT: port })).toThrow(ConfigValidationError);
    });
  });

  describe('required infrastructure settings', () => {
    it('rejects a DATABASE_URL that is not a PostgreSQL connection string', () => {
      expect(() => loadConfig({ ...minimalEnv, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
        ConfigValidationError,
      );
    });

    it('requires AWS_REGION', () => {
      expect(() => loadConfig({ DATABASE_URL: minimalEnv.DATABASE_URL })).toThrow(
        ConfigValidationError,
      );
    });

    it('accepts an explicit SQS endpoint for the local emulator', () => {
      const config = loadConfig({ ...minimalEnv, SQS_ENDPOINT: 'http://ministack:4566' });

      expect(config.sqs.endpoint).toBe('http://ministack:4566');
    });
  });

  describe('error reporting', () => {
    it('names every invalid variable in a single error', () => {
      const error = captureError(() => loadConfig({ APP_ROLES: 'cron', HTTP_PORT: '-1' }));

      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.message).toContain('APP_ROLES');
      expect(error.message).toContain('HTTP_PORT');
      expect(error.message).toContain('DATABASE_URL');
      expect(error.message).toContain('AWS_REGION');
    });

    it('never echoes secret values in the message', () => {
      const error = captureError(() =>
        loadConfig({ ...minimalEnv, DATABASE_URL: 'mysql://root:hunter2@db/x' }),
      );

      expect(error.message).not.toContain('hunter2');
    });
  });
});

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error instance, got ${String(error)}`, { cause: error });
  }
  throw new Error('expected the function to throw');
}
