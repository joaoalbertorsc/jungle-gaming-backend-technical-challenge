import type { Wallet } from '../../wallet/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import {
  type WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from './wager-transaction';
import { InvalidTransactionStateError } from './wagering-errors';

export interface ProcessWagerInput {
  /** PENDING, or PENDING_REFERENCE when retried by the worker. */
  readonly transaction: WagerTransaction;
  /** The transaction's wallet, already locked by the caller (ADR-0007). */
  readonly wallet: Wallet;
  /** Resolved by (providerId, referenceExternalTransactionId); undefined when not found. */
  readonly reference: WagerTransaction | undefined;
  /** Whether a PROCESSED REFUND or ROLLBACK already points at the reference. */
  readonly referenceAlreadyReversed: boolean;
  /** Id for the ledger entry, should the transaction move the balance. */
  readonly ledgerEntryId: string;
  readonly at: Date;
}

export type ProcessWagerOutcome =
  | { readonly type: 'processed'; readonly ledgerEntry: WalletLedgerEntry | undefined }
  | { readonly type: 'rejected'; readonly failureCode: FailureCode }
  | { readonly type: 'pending-reference' };

/** Kinds each transaction kind may reference (§7 rule 3). */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<Kind, readonly Kind[]>>> = {
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};

const UNDECIDED_STATUSES: readonly Status[] = [Status.Pending, Status.PendingReference];

/**
 * Applies the business rules of §7 to one transaction against its locked wallet.
 *
 * It mutates the aggregates (transaction status, wallet balance) and returns the outcome; it never
 * performs I/O. Rejections leave the wallet untouched and produce no ledger entry.
 */
export class WagerTransactionProcessor {
  process(input: ProcessWagerInput): ProcessWagerOutcome {
    const { transaction, wallet, reference } = input;
    this.assertProcessable(transaction, wallet);

    const rejection =
      this.checkWallet(transaction, wallet) ??
      (transaction.hasReference() ? this.checkReference(input) : undefined);
    if (rejection === 'pending-reference') return this.park(transaction, wallet);
    if (rejection !== undefined) return this.reject(input, rejection);

    if (!transaction.affectsBalance()) {
      return this.markProcessed(input, undefined);
    }

    const direction = transaction.ledgerDirectionFor(reference);
    const movement = {
      entryId: input.ledgerEntryId,
      transactionId: transaction.id,
      money: transaction.money,
      at: input.at,
    };

    if (direction === LedgerDirection.Credit) {
      return this.markProcessed(input, wallet.credit(movement));
    }
    if (!wallet.canDebit(transaction.money)) {
      return this.reject(
        input,
        transaction.kind === Kind.Rollback
          ? FailureCode.ReversalWouldOverdraw
          : FailureCode.InsufficientFunds,
      );
    }
    return this.markProcessed(input, wallet.debit(movement));
  }

  private checkWallet(transaction: WagerTransaction, wallet: Wallet): FailureCode | undefined {
    if (transaction.playerId !== wallet.playerId) return FailureCode.WalletPlayerMismatch;
    if (transaction.money.currency !== wallet.currency) return FailureCode.CurrencyMismatch;
    return undefined;
  }

  private checkReference(input: ProcessWagerInput): FailureCode | 'pending-reference' | undefined {
    const { transaction, reference } = input;
    if (reference === undefined) return 'pending-reference';

    const sameContext =
      reference.providerId === transaction.providerId &&
      reference.playerId === transaction.playerId &&
      reference.walletId === transaction.walletId &&
      reference.roundId === transaction.roundId &&
      reference.money.currency === transaction.money.currency;
    if (!sameContext) return FailureCode.ReferenceMismatch;

    const allowedKinds = ALLOWED_REFERENCE_KINDS[transaction.kind] ?? [];
    if (!allowedKinds.includes(reference.kind)) return FailureCode.InvalidReferenceKind;

    if (UNDECIDED_STATUSES.includes(reference.status)) return 'pending-reference';
    if (reference.status !== Status.Processed) return FailureCode.ReferenceNotProcessed;

    if (transaction.isReversal()) {
      if (input.referenceAlreadyReversed) return FailureCode.AlreadyReversed;
      if (!transaction.money.equals(reference.money)) return FailureCode.AmountMismatch;
    }
    return undefined;
  }

  private markProcessed(
    input: ProcessWagerInput,
    ledgerEntry: WalletLedgerEntry | undefined,
  ): ProcessWagerOutcome {
    input.transaction.markProcessed({
      referenceTransactionId: input.reference?.id,
      resultingBalance: input.wallet.balance,
      at: input.at,
    });
    return { type: 'processed', ledgerEntry };
  }

  private reject(input: ProcessWagerInput, failureCode: FailureCode): ProcessWagerOutcome {
    input.transaction.reject({
      failureCode,
      resultingBalance: input.wallet.balance,
      at: input.at,
    });
    return { type: 'rejected', failureCode };
  }

  private park(transaction: WagerTransaction, wallet: Wallet): ProcessWagerOutcome {
    if (transaction.status === Status.Pending) {
      transaction.markPendingReference({ observedBalance: wallet.balance });
    }
    return { type: 'pending-reference' };
  }

  private assertProcessable(transaction: WagerTransaction, wallet: Wallet): void {
    if (transaction.walletId !== wallet.id) {
      throw new InvalidTransactionStateError(transaction.id, `does not belong to wallet ${wallet.id}`);
    }
    if (!UNDECIDED_STATUSES.includes(transaction.status)) {
      throw new InvalidTransactionStateError(transaction.id, `already ${transaction.status}`);
    }
  }
}
