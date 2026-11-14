import { TransientInfrastructureError } from '../../../shared/application/application-errors';
import { PollingLoop } from '../../../shared/application/polling-loop';
import type {
  ApplicationLogger,
  ApplicationMetrics,
  Clock,
  FaultInjector,
  IdGenerator,
} from '../../../shared/application/ports';
import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import { FailureCode } from '../domain/failure-code';
import type { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import type { WagerTransaction } from '../domain/wager-transaction';
import {
  type ProcessWagerOutcome,
  WagerTransactionProcessor,
} from '../domain/wager-transaction-processor';
import type { PendingReferenceClaim, PendingReferenceQueue } from './ports';
import { outcomeEvents, recordOutcomeEffects, resolveReference } from './wager-outcome-effects';

export interface RetryPendingReferencesSettings {
  readonly queue: PendingReferenceQueue;
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly metrics: ApplicationMetrics;
  readonly logger: ApplicationLogger;
  readonly faults?: FaultInjector | undefined;
  readonly policy: ReferenceRetryPolicy;
  readonly batchSize: number;
  readonly leaseMs: number;
  /** Pause between polls when nothing is due. */
  readonly pollIntervalMs: number;
}

export interface RetryRound {
  /** The reference resolved and the transaction was PROCESSED. */
  readonly processed: readonly string[];
  /** Decided as REJECTED: a §7 rule failed, or the attempts ran out. */
  readonly rejected: readonly string[];
  /** The reference is still missing; the next attempt is scheduled. */
  readonly rescheduled: readonly string[];
  /** Decided meanwhile, or this attempt was already made by another worker. */
  readonly skipped: readonly string[];
  /** The attempt failed (e.g. lock timeout) and is retried once the lease expires. */
  readonly failed: readonly string[];
}

type Attempt =
  | { readonly result: 'processed' | 'rejected'; readonly transaction: WagerTransaction }
  | { readonly result: 'rescheduled' | 'skipped' };

/**
 * The retry worker for PENDING_REFERENCE transactions (§7 rule 8, ADR-0012). Each claimed
 * transaction is re-evaluated under its wallet lock with the same §7 rules as on arrival, in one
 * SQL transaction with its ledger entry, wallet balance and events. Any number of workers can run.
 */
export class RetryPendingReferences {
  private readonly processor = new WagerTransactionProcessor();
  private readonly loop: PollingLoop;

  constructor(private readonly settings: RetryPendingReferencesSettings) {
    this.loop = new PollingLoop({
      name: 'retry worker',
      pollIntervalMs: settings.pollIntervalMs,
      logger: settings.logger,
      round: async () => {
        const round = await this.retryOnce();
        return Object.values(round).some((ids: readonly string[]) => ids.length > 0);
      },
    });
  }

  async retryOnce(): Promise<RetryRound> {
    const { queue, clock, batchSize, leaseMs, metrics, logger } = this.settings;
    const claims = await queue.claimDue(clock.now(), batchSize, leaseMs);
    const round: Record<keyof RetryRound, string[]> = {
      processed: [],
      rejected: [],
      rescheduled: [],
      skipped: [],
      failed: [],
    };

    for (const claim of claims) {
      try {
        const attempt = await this.retry(claim);
        round[attempt.result].push(claim.transactionId);
        if (attempt.result === 'processed' || attempt.result === 'rejected') {
          const { kind, status } = attempt.transaction;
          metrics.transactionOutcome(kind, status, 'worker');
        }
        if (attempt.result !== 'skipped') metrics.referenceRetry(attempt.result);
      } catch (error) {
        if (error instanceof TransientInfrastructureError && error.reason === 'LOCK_TIMEOUT') {
          metrics.lockConflict();
        }
        logger.warn('pending reference retry failed; retried after the lease', {
          transactionId: claim.transactionId,
          error: error instanceof Error ? error.message : String(error),
        });
        round.failed.push(claim.transactionId);
      }
    }
    return round;
  }

  start(): void {
    this.loop.start();
  }

  /** Finishes the current round; claimed but unfinished transactions are retried after the lease. */
  stop(): Promise<void> {
    return this.loop.stop();
  }

  private retry(claim: PendingReferenceClaim): Promise<Attempt> {
    const { unitOfWork, clock, ids, policy, faults } = this.settings;

    return unitOfWork.transaction(async (repositories): Promise<Attempt> => {
      // The same lock as every other write on this wallet (ADR-0007).
      const wallet = await repositories.wallets.lockById(claim.walletId);
      const pending = await repositories.transactions.findPendingReference(claim.transactionId);
      // Decided meanwhile, or a worker that claimed the row after our lease expired made this attempt.
      if (wallet === undefined || pending === undefined || pending.attempts !== claim.attempts) {
        return { result: 'skipped' };
      }

      const { transaction } = pending;
      const count = pending.attempts + 1;
      const at = clock.now();
      const resolved = await resolveReference(repositories.transactions, transaction);
      let outcome: ProcessWagerOutcome = this.processor.process({
        transaction,
        wallet,
        ...resolved,
        ledgerEntryId: ids.next(),
        at,
      });

      if (outcome.type === 'pending-reference') {
        const next = policy.afterUnresolved(count, at);
        if (next.type === 'retry') {
          repositories.transactions.recordReferenceAttempt(transaction.id, {
            count,
            nextAttemptAt: next.at,
            at,
          });
          faults?.hit('pending-reference.before-commit');
          return { result: 'rescheduled' };
        }
        // Out of attempts: the failure code says whether the reference never arrived or never settled.
        const failureCode =
          resolved.reference === undefined
            ? FailureCode.ReferenceNotFound
            : FailureCode.ReferenceNotProcessed;
        transaction.reject({ failureCode, resultingBalance: wallet.balance, at });
        outcome = { type: 'rejected', failureCode };
      }

      repositories.transactions.save(transaction);
      repositories.transactions.recordReferenceAttempt(transaction.id, {
        count,
        nextAttemptAt: undefined,
        at,
      });
      const correlationId = ids.next();
      await recordOutcomeEffects(repositories, {
        transaction,
        wallet,
        outcome,
        events: outcomeEvents(transaction, wallet, outcome, () => ({
          eventId: ids.next(),
          correlationId,
          causationId: transaction.id,
          occurredAt: at,
        })),
        at,
      });

      faults?.hit('pending-reference.before-commit');
      return { result: outcome.type === 'processed' ? 'processed' : 'rejected', transaction };
    });
  }
}
