import { CurrencyMismatchError } from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/money';
import { InsufficientFundsError, InvalidWalletOperationError } from './wallet-errors';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  /** Required when the initial balance is positive: ids of the OPENING transaction and its entry. */
  readonly openingCredit?: { readonly entryId: string; readonly transactionId: string };
  readonly at: Date;
}

export interface OpenedWallet {
  readonly wallet: Wallet;
  /** CREDIT entry of the internal OPENING transaction; absent for a zero initial balance. */
  readonly openingEntry: WalletLedgerEntry | undefined;
}

/** A balance movement applied to the wallet; it always produces exactly one ledger entry. */
export interface WalletMovement {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

/**
 * Aggregate root for a player's balance in one currency (§6.2).
 *
 * Invariants kept by construction:
 * - the balance never goes negative;
 * - every balance change returns its ledger entry, whose `balanceAfter` and `walletVersion` match
 *   the wallet's new state (and nothing else changes the balance);
 * - `version` starts at 1 and increments only when the balance changes;
 * - every movement uses the wallet's currency.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('initial balance cannot be negative');
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      new Date(at.getTime()),
      new Date(at.getTime()),
    );
    if (initialBalance.isZero()) return { wallet, openingEntry: undefined };

    if (props.openingCredit === undefined) {
      throw new InvalidWalletOperationError(
        'a positive initial balance requires the OPENING transaction and entry ids',
      );
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingCredit.entryId,
      walletId: wallet.id,
      transactionId: props.openingCredit.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence: no validation (§6.0). */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Debits the wallet. Throws {@link InsufficientFundsError} instead of going negative. */
  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValidMovement(movement);
    if (!this.canDebit(movement.money)) throw new InsufficientFundsError(this.id);
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValidMovement(movement);
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? balanceBefore.subtract(movement.money)
        : balanceBefore.add(movement.money);

    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = new Date(movement.at.getTime());
    return entry;
  }

  private assertValidMovement(movement: WalletMovement): void {
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvalidWalletOperationError('movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
