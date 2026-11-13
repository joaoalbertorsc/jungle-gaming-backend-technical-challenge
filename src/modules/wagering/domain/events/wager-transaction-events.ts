import { type EventContext, IntegrationEvent } from '../../../../shared/domain/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { FailureCode } from '../failure-code';
import { type WagerTransaction, WagerTransactionStatus } from '../wager-transaction';
import { InvalidTransactionStateError } from '../wagering-errors';

/** Fields shared by every wager transaction event. */
export interface WagerTransactionEventData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly status: WagerTransactionStatus;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  readonly referenceTransactionId?: string;
  readonly balance: MoneyProps;
  readonly processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  readonly failureCode: FailureCode;
  readonly balance: MoneyProps;
  readonly rejectedAt: string;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  readonly referenceExternalTransactionId: string;
}

/** Any applied transaction, including LOSS (§11). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...commonData(transaction),
        ...optional('referenceTransactionId', transaction.referenceTransactionId),
        balance: required(transaction, transaction.resultingBalance, 'resultingBalance').toJSON(),
        processedAt: required(transaction, transaction.processedAt, 'processedAt').toISOString(),
      },
    });
  }
}

/** A transaction rejected by a business rule. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...commonData(transaction),
        failureCode: required(transaction, transaction.failureCode, 'failureCode'),
        balance: required(transaction, transaction.resultingBalance, 'resultingBalance').toJSON(),
        rejectedAt: required(transaction, transaction.completedAt, 'completedAt').toISOString(),
      },
    });
  }
}

/** A transaction parked until its reference arrives (§7.1). */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    assertStatus(
      transaction,
      WagerTransactionStatus.PendingReference,
      'WagerTransactionPendingReference',
    );
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...commonData(transaction),
        referenceExternalTransactionId: required(
          transaction,
          transaction.referenceExternalTransactionId,
          'referenceExternalTransactionId',
        ),
      },
    });
  }
}

function commonData(transaction: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    ...optional('referenceExternalTransactionId', transaction.referenceExternalTransactionId),
  };
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function required<T>(transaction: WagerTransaction, value: T | undefined, field: string): T {
  if (value === undefined) {
    throw new InvalidTransactionStateError(transaction.id, `missing ${field} for event`);
  }
  return value;
}

function assertStatus(
  transaction: WagerTransaction,
  expected: WagerTransactionStatus,
  eventType: string,
): void {
  if (transaction.status !== expected) {
    throw new InvalidTransactionStateError(
      transaction.id,
      `${eventType} requires ${expected}, got ${transaction.status}`,
    );
  }
}
