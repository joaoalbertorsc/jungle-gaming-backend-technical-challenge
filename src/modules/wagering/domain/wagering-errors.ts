import { DomainError } from '../../../shared/domain/errors';

export type InvalidWagerTransactionReason =
  | 'MISSING_FIELD'
  | 'UNKNOWN_KIND'
  | 'OPENING_NOT_SUBMITTABLE'
  | 'RESERVED_PROVIDER'
  | 'REFERENCE_REQUIRED'
  | 'REFERENCE_NOT_ALLOWED'
  | 'SELF_REFERENCE'
  | 'AMOUNT_MUST_BE_POSITIVE';

/** A submission that can never be valid, whatever the state: maps to "invalid payload". */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';

  constructor(
    readonly reason: InvalidWagerTransactionReason,
    detail: string,
  ) {
    super(`Invalid wager transaction (${reason}): ${detail}`);
  }
}

/**
 * A transition attempted from a state that does not allow it. Terminal states are final, so this is
 * a programming error, never a business path (§6.3).
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(transactionId: string, detail: string) {
    super(`Transaction ${transactionId}: ${detail}`);
  }
}
