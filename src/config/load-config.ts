import { z } from 'zod';

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
    },
  };
}
