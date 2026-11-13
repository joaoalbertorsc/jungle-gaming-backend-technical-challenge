import { DomainError } from '../../../shared/domain/errors';

/** A debit larger than the available balance. The aggregate refuses it to stay non-negative. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(walletId: string) {
    super(`Wallet ${walletId} has insufficient funds for this debit`);
  }
}

/** A wallet operation called with arguments that can never be valid (programming error). */
export class InvalidWalletOperationError extends DomainError {
  readonly code = 'INVALID_WALLET_OPERATION';

  constructor(reason: string) {
    super(`Invalid wallet operation: ${reason}`);
  }
}

/** A ledger entry whose fields do not describe a valid, balanced movement. */
export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';

  constructor(reason: string) {
    super(`Invalid ledger entry: ${reason}`);
  }
}
