import type { Money } from '../../../shared/domain/money';
import { InvalidLedgerEntryError } from './wallet-errors';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  /** Always positive; the direction carries the sign. */
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** Wallet version produced by this movement (gap-free per wallet, starting at 1). */
  readonly walletVersion: number;
  readonly createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * One immutable line of the wallet ledger (§6.4). Immutability is structural: every field is
 * readonly, the instance is frozen, and the class exposes no state-changing method.
 */
export class WalletLedgerEntry implements LedgerEntryState {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Validates the movement: positive amount, balanced arithmetic, non-negative result. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('amount must be positive');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError('wallet version must be a positive integer');
    }
    if (props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('balance after the movement cannot be negative');
    }

    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('balanceBefore ± money must equal balanceAfter');
    }
    return entry;
  }

  /** Reconstruction from persistence: no validation (§6.0). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      new Date(state.createdAt.getTime()),
    );
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    return this.balanceBefore.add(this.signedAmount()).equals(this.balanceAfter);
  }

  /** The movement as a signed amount: negative for debits, positive for credits. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Debit ? this.money.negate() : this.money;
  }
}
