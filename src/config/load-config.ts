import { z } from 'zod';
import { FAULT_POINTS, type FaultPoint } from '../shared/application/ports';

/** Every process runs the same image; APP_ROLES selects which parts it activates (ADR 0001). */
export const APP_ROLES = ['api', 'consumer', 'outbox-relay', 'retry-worker'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  readonly roles: readonly AppRole[];
  readonly logLevel: LogLevel;
  readonly http: { readonly port: number };
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    /** Upper bound for waiting on a wallet row lock (ADR-0007). */
    readonly lockTimeoutMs: number;
  };
  readonly sqs: {
    readonly region: string;
    /** Set only for local emulators; undefined lets the AWS SDK resolve the real endpoint. */
    readonly endpoint: string | undefined;
    readonly queues: {
      readonly wagerTransactions: string;
      readonly wagerTransactionsDlq: string;
      readonly wageringEvents: string;
    };
    readonly consumer: {
      /** SQS long poll (0–20 s). */
      readonly waitTimeSeconds: number;
      /** Messages per ReceiveMessage (1–10). */
      readonly maxMessages: number;
      /** How long a SIGTERM waits for in-flight messages. */
      readonly drainTimeoutMs: number;
      readonly retryBaseMs: number;
      readonly retryMaxMs: number;
    };
  };
  readonly outbox: {
    readonly batchSize: number;
    /** How long a claim protects a message from other relays (ADR-0011). */
    readonly leaseMs: number;
    readonly pollIntervalMs: number;
    readonly retryBaseMs: number;
    readonly retryMaxMs: number;
  };
  /** The PENDING_REFERENCE retry worker (ADR-0012). */
  readonly referenceRetry: {
    readonly batchSize: number;
    /** How long a claim protects a transaction from other workers. */
    readonly leaseMs: number;
    readonly pollIntervalMs: number;
    /** Wait before retry 1; it doubles on each attempt up to `maxMs`. */
    readonly baseMs: number;
    readonly maxMs: number;
    /** Attempts before the transaction is rejected with REFERENCE_NOT_FOUND. */
    readonly maxAttempts: number;
  };
  /** Test-only crash injection (ADR-0017); always undefined outside NODE_ENV=test. */
  readonly faults: {
    /** The process exits at once when it reaches this point, as if it had been killed. */
    readonly crashAt: FaultPoint | undefined;
  };
}

const rolesSchema = z
  .string()
  .default('api')
  .transform((raw) => [
    ...new Set(
      raw
        .split(',')
        .map((role) => role.trim())
        .filter((role) => role.length > 0),
    ),
  ])
  .pipe(z.array(z.enum(APP_ROLES)).min(1, 'at least one role is required'));

const queueName = (fallback: string) => z.string().trim().min(1).default(fallback);

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  FAULT_CRASH_AT: z.enum(FAULT_POINTS).optional(),
  APP_ROLES: rolesSchema,
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgresql:// URL' }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(2000),
  AWS_REGION: z.string().trim().min(1),
  SQS_ENDPOINT: z.url().optional(),
  WAGER_TRANSACTIONS_QUEUE: queueName('wager-transactions.fifo'),
  WAGER_TRANSACTIONS_DLQ: queueName('wager-transactions-dlq.fifo'),
  WAGERING_EVENTS_QUEUE: queueName('wagering-events.fifo'),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(10),
  CONSUMER_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(0).max(300_000).default(15_000),
  SQS_RETRY_BASE_MS: z.coerce.number().int().min(1).max(60_000).default(1_000),
  SQS_RETRY_MAX_MS: z.coerce.number().int().min(1).max(43_200_000).default(60_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_LEASE_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(500),
  OUTBOX_RETRY_BASE_MS: z.coerce.number().int().min(1).max(60_000).default(1_000),
  OUTBOX_RETRY_MAX_MS: z.coerce.number().int().min(1).max(3_600_000).default(300_000),
  REFERENCE_RETRY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  REFERENCE_RETRY_LEASE_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  REFERENCE_RETRY_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(500),
  REFERENCE_RETRY_BASE_MS: z.coerce.number().int().min(1).max(60_000).default(1_000),
  REFERENCE_RETRY_MAX_MS: z.coerce.number().int().min(1).max(3_600_000).default(300_000),
  REFERENCE_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
});

export class ConfigValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validates the environment once at startup and returns a typed, immutable config.
 * Issue messages carry variable names and rules only, never the offending values (they may be secrets).
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  const parsed = result.data;
  if (parsed.FAULT_CRASH_AT !== undefined && parsed.NODE_ENV !== 'test') {
    throw new ConfigValidationError([
      'FAULT_CRASH_AT: fault injection is only honoured when NODE_ENV=test',
    ]);
  }
  return {
    roles: parsed.APP_ROLES,
    logLevel: parsed.LOG_LEVEL,
    http: { port: parsed.HTTP_PORT },
    database: {
      url: parsed.DATABASE_URL,
      poolMax: parsed.DB_POOL_MAX,
      lockTimeoutMs: parsed.DB_LOCK_TIMEOUT_MS,
    },
    sqs: {
      region: parsed.AWS_REGION,
      endpoint: parsed.SQS_ENDPOINT,
      queues: {
        wagerTransactions: parsed.WAGER_TRANSACTIONS_QUEUE,
        wagerTransactionsDlq: parsed.WAGER_TRANSACTIONS_DLQ,
        wageringEvents: parsed.WAGERING_EVENTS_QUEUE,
      },
      consumer: {
        waitTimeSeconds: parsed.SQS_WAIT_TIME_SECONDS,
        maxMessages: parsed.SQS_MAX_MESSAGES,
        drainTimeoutMs: parsed.CONSUMER_DRAIN_TIMEOUT_MS,
        retryBaseMs: parsed.SQS_RETRY_BASE_MS,
        retryMaxMs: Math.max(parsed.SQS_RETRY_MAX_MS, parsed.SQS_RETRY_BASE_MS),
      },
    },
    outbox: {
      batchSize: parsed.OUTBOX_BATCH_SIZE,
      leaseMs: parsed.OUTBOX_LEASE_MS,
      pollIntervalMs: parsed.OUTBOX_POLL_INTERVAL_MS,
      retryBaseMs: parsed.OUTBOX_RETRY_BASE_MS,
      retryMaxMs: Math.max(parsed.OUTBOX_RETRY_MAX_MS, parsed.OUTBOX_RETRY_BASE_MS),
    },
    referenceRetry: {
      batchSize: parsed.REFERENCE_RETRY_BATCH_SIZE,
      leaseMs: parsed.REFERENCE_RETRY_LEASE_MS,
      pollIntervalMs: parsed.REFERENCE_RETRY_POLL_INTERVAL_MS,
      baseMs: parsed.REFERENCE_RETRY_BASE_MS,
      maxMs: Math.max(parsed.REFERENCE_RETRY_MAX_MS, parsed.REFERENCE_RETRY_BASE_MS),
      maxAttempts: parsed.REFERENCE_RETRY_MAX_ATTEMPTS,
    },
    faults: { crashAt: parsed.FAULT_CRASH_AT },
  };
}
