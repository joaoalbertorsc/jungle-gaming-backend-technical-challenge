import type { OutboxRepository } from '../../modules/messaging/application/ports';
import type { WagerTransactionRepository } from '../../modules/wagering/application/ports';
import type { LedgerRepository, WalletRepository } from '../../modules/wallet/application/ports';

/** Repositories bound to one SQL transaction. */
export interface Repositories {
  readonly wallets: WalletRepository;
  readonly ledger: LedgerRepository;
  readonly transactions: WagerTransactionRepository;
  readonly outbox: OutboxRepository;
}

/**
 * Transaction boundary port (ADR-0004). Everything `work` writes through the repositories commits
 * together, or nothing does. Implementations translate driver errors into application errors
 * (TransientInfrastructureError, UniqueViolationError).
 */
export interface UnitOfWork {
  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
  /** Read-only, REPEATABLE READ: one consistent snapshot for multi-query reads (ADR-0013). */
  snapshot<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
  /** Plain reads outside an explicit transaction. */
  read<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
