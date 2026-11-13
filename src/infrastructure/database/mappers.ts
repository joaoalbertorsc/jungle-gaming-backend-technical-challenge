import type { OutboxMessage } from '../../modules/messaging/domain/outbox-message';
import { FailureCode } from '../../modules/wagering/domain/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../modules/wagering/domain/wager-transaction';
import { Wallet } from '../../modules/wallet/domain/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../modules/wallet/domain/wallet-ledger-entry';
import { Money } from '../../shared/domain/money';
import type {
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './entities';

/** Record ↔ domain mapping. Domain objects are rebuilt with `rehydrate`, never re-validated (§6.0). */

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });

/** Text column → enum member. An unknown value means a corrupted row, so it fails loudly. */
function enumValue<E extends Record<string, string>>(
  enumeration: E,
  value: string,
  column: string,
): E[keyof E] {
  const member = Object.values(enumeration).find((candidate) => candidate === value);
  if (member === undefined) throw new Error(`unexpected ${column} value "${value}"`);
  return member as E[keyof E];
}

export function walletFromRecord(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function transactionFromRecord(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.wallet,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: enumValue(WagerTransactionKind, record.kind, 'kind'),
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: enumValue(WagerTransactionStatus, record.status, 'status'),
    referenceTransactionId: record.referenceTransaction ?? undefined,
    failureCode:
      record.failureCode === null
        ? undefined
        : enumValue(FailureCode, record.failureCode, 'failure_code'),
    resultingBalance:
      record.resultingBalance === null || record.resultingBalanceCurrency === null
        ? undefined
        : money(record.resultingBalance, record.resultingBalanceCurrency),
    completedAt: record.completedAt ?? undefined,
  });
}

/** Columns a transaction may change after insert (the rest is immutable, enforced by the schema). */
export function transactionOutcomeColumns(
  transaction: WagerTransaction,
): Pick<
  WagerTransactionRecord,
  | 'status'
  | 'referenceTransaction'
  | 'failureCode'
  | 'resultingBalance'
  | 'resultingBalanceCurrency'
  | 'completedAt'
> {
  return {
    status: transaction.status,
    referenceTransaction: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    resultingBalance: transaction.resultingBalance?.amount ?? null,
    resultingBalanceCurrency: transaction.resultingBalance?.currency ?? null,
    completedAt: transaction.completedAt ?? null,
  };
}

export function transactionToRecord(
  transaction: WagerTransaction,
  scheduling: { nextReferenceAttemptAt?: Date | undefined },
): WagerTransactionRecord {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    wallet: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    ...transactionOutcomeColumns(transaction),
    referenceAttempts: 0,
    nextReferenceAttemptAt: scheduling.nextReferenceAttemptAt ?? null,
    createdAt: transaction.createdAt,
    updatedAt: transaction.completedAt ?? transaction.createdAt,
  };
}

export function ledgerEntryFromRecord(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.wallet,
    transactionId: record.transaction,
    direction: enumValue(LedgerDirection, record.direction, 'direction'),
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    wallet: entry.walletId,
    transaction: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

export function outboxMessageToRecord(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
    publishedAt: message.publishedAt ?? null,
    lastError: null,
  };
}

/** A NUMERIC sum as text (may be signed in a corrupted ledger) to Money. */
export function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? money(amount.slice(1), currency).negate()
    : money(amount, currency);
}
