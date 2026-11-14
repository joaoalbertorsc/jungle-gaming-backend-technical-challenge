import type { WagerTransaction } from '../domain/wager-transaction';

/** A due PENDING_REFERENCE transaction leased to one retry worker. */
export interface PendingReferenceClaim {
  readonly transactionId: string;
  readonly walletId: string;
  /** Worker attempts already made when the row was claimed. */
  readonly attempts: number;
}

/** Due PENDING_REFERENCE transactions for the retry worker: short autocommit statements. */
export interface PendingReferenceQueue {
  /**
   * Atomically claims up to `limit` due transactions by pushing `next_reference_attempt_at` to
   * `now + leaseMs` (FOR UPDATE SKIP LOCKED). If the worker dies, the lease expires and another
   * worker claims them (ADR-0012).
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<PendingReferenceClaim[]>;
}

export interface PendingReferenceState {
  readonly transaction: WagerTransaction;
  /** Worker attempts made so far. */
  readonly attempts: number;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Whether a PROCESSED REFUND or ROLLBACK already points at this transaction. */
  isReversed(referenceTransactionId: string): Promise<boolean>;
  /**
   * Adds a new transaction. `nextReferenceAttemptAt` schedules the retry worker for a transaction
   * parked as PENDING_REFERENCE (ADR-0012).
   */
  add(transaction: WagerTransaction, options?: { nextReferenceAttemptAt?: Date }): void;
  /** Persists the new state of a transaction loaded in this unit of work. */
  save(transaction: WagerTransaction): void;
  /**
   * Makes PENDING_REFERENCE transactions waiting on (providerId, externalTransactionId) due now,
   * so they are retried right after their reference arrives. Returns how many were nudged.
   */
  nudgeWaitingOn(providerId: string, externalTransactionId: string, at: Date): Promise<number>;
  /** The transaction, if it is still PENDING_REFERENCE, with the worker attempts made so far. */
  findPendingReference(id: string): Promise<PendingReferenceState | undefined>;
  /**
   * Records worker attempt number `count` on a transaction loaded in this unit of work.
   * `nextAttemptAt` schedules the next one; undefined once the transaction is decided.
   */
  recordReferenceAttempt(
    id: string,
    attempt: {
      readonly count: number;
      readonly nextAttemptAt: Date | undefined;
      readonly at: Date;
    },
  ): void;
}
