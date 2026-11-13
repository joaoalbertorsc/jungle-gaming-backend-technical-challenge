/**
 * Stable, machine-readable reasons persisted with a REJECTED or FAILED transaction (§7.2, ADR-0009).
 * The provider decides from the code alone whether to resend, fix the payload or give up.
 */
export enum FailureCode {
  /** BET larger than the available balance. Do not resend. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversing a credit (ROLLBACK of WIN/REFUND) would make the balance negative. Needs an operator. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Operation currency differs from the wallet currency. Fix the payload. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** The wallet belongs to another player. Fix the payload. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** The referenced transaction never arrived within the retry budget (ADR-0012). */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** The reference belongs to another player, wallet, currency or round. Fix the payload. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** REFUND not pointing at a BET; ROLLBACK not at BET/WIN/REFUND; WIN/LOSS not at a BET. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** The reference ended REJECTED or FAILED, so there is nothing to act on. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** The reference was already reversed (by a REFUND or a ROLLBACK). */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Reversal amount differs from the reference amount (partial reversals are out of scope). */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** Permanent infrastructure failure (FAILED status), kept for audit. */
  ProcessingFailed = 'PROCESSING_FAILED',
}
