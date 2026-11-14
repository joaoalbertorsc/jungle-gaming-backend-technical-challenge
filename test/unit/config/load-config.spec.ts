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
