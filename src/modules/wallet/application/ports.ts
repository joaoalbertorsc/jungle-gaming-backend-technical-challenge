import type { Money } from '../../../shared/domain/money';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletRepository {
  /** Loads and row-locks the wallet (SELECT ... FOR UPDATE) for the rest of the transaction (ADR-0007). */
  lockById(id: string): Promise<Wallet | undefined>;
  findById(id: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  /** Persists the new state of a wallet loaded in this transaction. */
  save(wallet: Wallet): void;
}

export interface LedgerSummary {
  /** Σ credits − Σ debits, in the wallet currency. */
  readonly balance: Money;
  readonly entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): void;
  /** Entries with walletVersion > afterVersion, ascending, at most `limit`. */
  page(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}
