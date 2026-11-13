import { Money, type MoneyProps } from '../../../shared/domain/money';
import type { FailureCode } from '../domain/failure-code';
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';

/** Response of POST /wagering/transactions (§9). */
export interface WagerOutcome {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly failureCode?: FailureCode;
  /** Balance observed when the outcome was decided (§7 rule 7). */
  readonly balance: MoneyProps;
  readonly idempotentReplay: boolean;
}

/** Read model of GET /wagering/transactions/:id and the provider lookup. */
export interface WagerTransactionView {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
  readonly status: WagerTransactionStatus;
  readonly failureCode?: FailureCode;
  readonly resultingBalance?: MoneyProps;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export function toWagerOutcome(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): WagerOutcome {
  const balance = transaction.resultingBalance ?? Money.zero(transaction.money.currency);
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    balance: balance.toJSON(),
    idempotentReplay,
  };
}

export function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  const resultingBalance = transaction.resultingBalance?.toJSON();
  const completedAt = transaction.completedAt?.toISOString();
  const { referenceExternalTransactionId, referenceTransactionId, failureCode } = transaction;
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
    ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
    status: transaction.status,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(resultingBalance === undefined ? {} : { resultingBalance }),
    createdAt: transaction.createdAt.toISOString(),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}
