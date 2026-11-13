import {
  ConnectionException,
  DeadlockException,
  IsolationLevel,
  LockWaitTimeoutException,
  type MikroORM,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';
import {
  TransientInfrastructureError,
  UniqueViolationError,
} from '../../shared/application/application-errors';
import type { Repositories, UnitOfWork } from '../../shared/application/unit-of-work';
import { mikroOrmRepositories } from './mikro-orm-repositories';

export interface UnitOfWorkSettings {
  /** Upper bound for waiting on a wallet row lock (ADR-0007). */
  readonly lockTimeoutMs: number;
}

/**
 * UnitOfWork over MikroORM (ADR-0004): every call forks a fresh EntityManager, so its identity map
 * lives exactly as long as one SQL transaction, and `em.transactional()` flushes and commits once.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly settings: UnitOfWorkSettings,
  ) {
    if (!Number.isInteger(settings.lockTimeoutMs) || settings.lockTimeoutMs <= 0) {
      throw new RangeError('lockTimeoutMs must be a positive integer');
    }
  }

  async transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return translateErrors(() =>
      this.orm.em.fork().transactional(async (em) => {
        await em.execute(`SET LOCAL lock_timeout = '${String(this.settings.lockTimeoutMs)}ms'`);
        return work(mikroOrmRepositories(em));
      }),
    );
  }

  async snapshot<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return translateErrors(() =>
      this.orm.em.fork().transactional((em) => work(mikroOrmRepositories(em)), {
        isolationLevel: IsolationLevel.REPEATABLE_READ,
        readOnly: true,
      }),
    );
  }

  async read<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return translateErrors(() => work(mikroOrmRepositories(this.orm.em.fork())));
  }
}

async function translateErrors<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw translate(error);
  }
}

/** SQLSTATEs that mean "try again later" (MikroORM does not map 55P03 to its own exception). */
const TRANSIENT_SQL_STATES: Readonly<Record<string, TransientInfrastructureError['reason']>> = {
  '55P03': 'LOCK_TIMEOUT', // lock_not_available: lock_timeout expired
  '40P01': 'LOCK_TIMEOUT', // deadlock_detected
  '40001': 'SERIALIZATION_FAILURE',
  '57P01': 'DATABASE_UNAVAILABLE', // admin_shutdown
  '08006': 'DATABASE_UNAVAILABLE', // connection_failure
};

/** Driver errors → application errors the use cases and transport adapters understand. */
export function translate(error: unknown): unknown {
  const transient = TRANSIENT_SQL_STATES[sqlStateOf(error) ?? ''];
  if (transient !== undefined) return new TransientInfrastructureError(transient, { cause: error });

  if (error instanceof LockWaitTimeoutException || error instanceof DeadlockException) {
    return new TransientInfrastructureError('LOCK_TIMEOUT', { cause: error });
  }
  if (error instanceof ConnectionException || isConnectionRefused(error)) {
    return new TransientInfrastructureError('DATABASE_UNAVAILABLE', { cause: error });
  }
  if (error instanceof UniqueConstraintViolationException) {
    return new UniqueViolationError(constraintName(error), { cause: error });
  }
  return error;
}

/** DriverException copies the pg error's own properties, so `code` holds the SQLSTATE. */
function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; sqlState?: unknown };
  const value = candidate.sqlState ?? candidate.code;
  return typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value) ? value : undefined;
}

function isConnectionRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT';
}

function constraintName(error: Error): string | undefined {
  const withCause = error as Error & { constraint?: string; cause?: { constraint?: string } };
  return (
    withCause.constraint ??
    withCause.cause?.constraint ??
    /constraint "([^"]+)"/.exec(error.message)?.[1] ??
    undefined
  );
}
