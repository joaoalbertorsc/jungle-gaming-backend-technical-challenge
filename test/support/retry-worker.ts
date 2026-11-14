import type { SQL } from 'bun';
import { MikroOrmPendingReferenceQueue } from '../../src/infrastructure/database/mikro-orm-pending-reference-queue';
import type { PendingReferenceQueue } from '../../src/modules/wagering/application/ports';
import { RetryPendingReferences } from '../../src/modules/wagering/application/retry-pending-references';
import { ReferenceRetryPolicy } from '../../src/modules/wagering/domain/reference-retry-policy';
import type { FaultInjector } from '../../src/shared/application/ports';
import type { TestApplication } from './application';

export interface RetryWorkerOptions {
  readonly faults?: FaultInjector;
  readonly leaseMs?: number;
  readonly batchSize?: number;
  readonly policy?: ReferenceRetryPolicy;
  readonly queue?: PendingReferenceQueue;
}

/** A real pending-reference worker (PostgreSQL queue + use case) tuned for fast tests. */
export function createTestRetryWorker(
  app: TestApplication,
  options: RetryWorkerOptions = {},
): RetryPendingReferences {
  return new RetryPendingReferences({
    queue: options.queue ?? new MikroOrmPendingReferenceQueue(app.orm),
    unitOfWork: app.unitOfWork,
    ids: app.ids,
    clock: app.clock,
    metrics: app.metrics,
    logger: app.logger,
    faults: options.faults,
    policy: options.policy ?? ReferenceRetryPolicy.DEFAULT,
    batchSize: options.batchSize ?? 50,
    leaseMs: options.leaseMs ?? 30_000,
    pollIntervalMs: 50,
  });
}

/** Pushes every waiting transaction out of reach, so a test only sees the ones it makes due. */
export async function deferAllPendingReferences(sql: SQL): Promise<void> {
  await sql`UPDATE wager_transactions SET next_reference_attempt_at = now() + interval '1 day'
            WHERE status = 'PENDING_REFERENCE'`;
}

/** Makes these PENDING_REFERENCE transactions due for the next worker round. */
export async function makeDue(sql: SQL, ...transactionIds: string[]): Promise<void> {
  await sql`UPDATE wager_transactions SET next_reference_attempt_at = now() - interval '1 second'
            WHERE id IN ${sql(transactionIds)}`;
}

export interface PendingRow {
  readonly status: string;
  readonly failure_code: string | null;
  readonly reference_attempts: number;
  readonly scheduled: boolean;
}

export async function pendingRow(sql: SQL, transactionId: string): Promise<PendingRow | undefined> {
  const rows: PendingRow[] = await sql`
    SELECT status, failure_code, reference_attempts, next_reference_attempt_at IS NOT NULL AS scheduled
    FROM wager_transactions WHERE id = ${transactionId}`;
  return rows[0];
}
