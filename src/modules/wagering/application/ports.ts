import type { WagerTransaction } from '../domain/wager-transaction';

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
}
