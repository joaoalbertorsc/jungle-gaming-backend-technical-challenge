import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import { createOrm } from '../../src/infrastructure/database/create-orm';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import {
  NoFaults,
  SystemClock,
  UuidV7Generator,
} from '../../src/infrastructure/system/system-adapters';
import { CreateWallet } from '../../src/modules/wallet/application/create-wallet';
import { ReconcileWallet } from '../../src/modules/wallet/application/reconcile-wallet';
import { GetWallet, GetWalletLedger } from '../../src/modules/wallet/application/wallet-queries';
import { SubmitWagerTransaction } from '../../src/modules/wagering/application/submit-wager-transaction';
import { GetWagerTransaction } from '../../src/modules/wagering/application/wager-transaction-queries';
import type { UnitOfWork } from '../../src/shared/application/unit-of-work';
import type {
  ApplicationLogger,
  ApplicationMetrics,
  Clock,
  FaultInjector,
  IdGenerator,
  FaultPoint,
  RequestContext,
} from '../../src/shared/application/ports';
import type { TestDatabase } from './test-database';

export class RecordingMetrics implements ApplicationMetrics {
  readonly calls: string[] = [];
  transactionOutcome(kind: string, status: string, channel: string): void {
    this.calls.push(`outcome:${kind}:${status}:${channel}`);
  }
  idempotentReplay(channel: string): void {
    this.calls.push(`replay:${channel}`);
  }
  lockConflict(): void {
    this.calls.push('lock-conflict');
  }
  reconciliationMismatch(): void {
    this.calls.push('reconciliation-mismatch');
  }
  duplicateMessage(consumer: string): void {
    this.calls.push(`duplicate:${consumer}`);
  }
  messageRetried(reason: string): void {
    this.calls.push(`retry:${reason}`);
  }
  deadLettered(reason: string): void {
    this.calls.push(`dead-letter:${reason}`);
  }
  outboxPublished(eventType: string): void {
    this.calls.push(`outbox-published:${eventType}`);
  }
  outboxFailed(): void {
    this.calls.push('outbox-failed');
  }
  referenceRetry(result: string): void {
    this.calls.push(`reference-retry:${result}`);
  }
}

export class RecordingLogger implements ApplicationLogger {
  readonly entries: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  info(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: 'info', message, fields });
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: 'warn', message, fields });
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: 'error', message, fields });
  }
}

/** Throws at one named point, to prove that nothing written before it is committed. */
export class FailAt implements FaultInjector {
  constructor(private readonly point: FaultPoint) {}
  hit(point: FaultPoint): void {
    if (point === this.point) throw new Error(`injected fault at ${point}`);
  }
}

export const httpContext: RequestContext = { correlationId: 'corr-test', channel: 'http' };

export interface TestApplication {
  readonly orm: MikroORM;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly metrics: RecordingMetrics;
  readonly logger: RecordingLogger;
  readonly createWallet: CreateWallet;
  readonly submit: SubmitWagerTransaction;
  readonly getWallet: GetWallet;
  readonly getLedger: GetWalletLedger;
  readonly getTransaction: GetWagerTransaction;
  readonly reconcile: ReconcileWallet;
  close(): Promise<void>;
}

/** The real application services wired to real adapters on a test database. */
export async function createTestApplication(
  db: TestDatabase,
  options: { faults?: FaultInjector; lockTimeoutMs?: number } = {},
): Promise<TestApplication> {
  const orm = await createOrm({ url: db.appUrl, poolMax: 10 });
  const unitOfWork = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: options.lockTimeoutMs ?? 2000 });
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  const faults = options.faults ?? new NoFaults();
  const metrics = new RecordingMetrics();
  const logger = new RecordingLogger();

  return {
    orm,
    unitOfWork,
    clock,
    ids,
    metrics,
    logger,
    createWallet: new CreateWallet(unitOfWork, ids, clock, faults),
    submit: new SubmitWagerTransaction(unitOfWork, ids, clock, faults, metrics),
    getWallet: new GetWallet(unitOfWork),
    getLedger: new GetWalletLedger(unitOfWork),
    getTransaction: new GetWagerTransaction(unitOfWork),
    reconcile: new ReconcileWallet(unitOfWork, logger, metrics),
    close: () => orm.close(true),
  };
}

/** §13 final invariant: the stored balance equals the balance rebuilt from the ledger. */
export async function assertLedgerMatchesBalance(sql: SQL, walletId: string): Promise<void> {
  // Compared exactly in SQL (NUMERIC), never through JavaScript numbers.
  const rows: { stored: string; rebuilt: string; consistent: boolean }[] = await sql`
    SELECT w.balance::text AS stored, r.rebuilt::text AS rebuilt, w.balance = r.rebuilt AS consistent
    FROM wallets w,
         LATERAL (SELECT COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
                         AS rebuilt
                  FROM wallet_ledger_entries l WHERE l.wallet_id = w.id) r
    WHERE w.id = ${walletId}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ consistent: true });
}

export async function count(
  sql: SQL,
  table: string,
  where: Record<string, string>,
): Promise<number> {
  const [column, value] = Object.entries(where)[0] ?? ['1', '1'];
  const rows: { n: number }[] =
    await sql`SELECT count(*)::int AS n FROM ${sql(table)} WHERE ${sql(column)} = ${value}`;
  return rows[0]?.n ?? 0;
}

export async function outboxEventTypes(
  sql: SQL,
  aggregateIds: readonly string[],
): Promise<string[]> {
  const rows: { event_type: string }[] = await sql`
    SELECT event_type FROM outbox_messages WHERE aggregate_id IN ${sql(aggregateIds)}
    ORDER BY occurred_at, event_type`;
  return rows.map((row) => row.event_type);
}

/** §13 final invariant over the whole database: no wallet anywhere disagrees with its ledger. */
export async function assertEveryWalletConsistent(sql: SQL): Promise<void> {
  const mismatches: { id: string; stored: string; rebuilt: string }[] = await sql`
    SELECT w.id, w.balance::text AS stored, r.rebuilt::text AS rebuilt
    FROM wallets w,
         LATERAL (SELECT COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
                         AS rebuilt
                  FROM wallet_ledger_entries l WHERE l.wallet_id = w.id) r
    WHERE w.balance <> r.rebuilt`;
  expect(mismatches).toEqual([]);
}
