import { EntitySchema } from '@mikro-orm/postgresql';

/**
 * A many-to-one relation exposed as its primary key (`mapToPk`). EntitySchema's types expect the
 * property to hold an entity, so the definition is typed loosely here; MikroORM still uses the
 * relation to order inserts by foreign key.
 */
function foreignKey(entity: () => new () => object, options: { nullable?: boolean } = {}): never {
  return { kind: 'm:1', entity, mapToPk: true, ...options } as never;
}

/**
 * Persistence models (ADR-0004). They mirror the tables one to one and hold raw column values:
 * money as decimal strings, enums as text. Domain objects are rebuilt from them by the mappers.
 * Relations are declared with `mapToPk` only so that the Unit of Work orders inserts by foreign key.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  wallet!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  status!: string;
  referenceTransaction!: string | null;
  failureCode!: string | null;
  resultingBalance!: string | null;
  resultingBalanceCurrency!: string | null;
  completedAt!: Date | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export class LedgerEntryRecord {
  id!: string;
  wallet!: string;
  transaction!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
  lastError!: string | null;
}

const money = { type: 'string' } as const;
const nullableMoney = { type: 'string', nullable: true } as const;
const timestamp = { type: 'Date' } as const;
const nullableTimestamp = { type: 'Date', nullable: true } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string' },
    currency: { type: 'string' },
    balance: money,
    version: { type: 'integer' },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string' },
    wallet: foreignKey(() => WalletRecord),
    playerId: { type: 'string' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: money,
    currency: { type: 'string' },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    status: { type: 'string' },
    referenceTransaction: foreignKey(() => WagerTransactionRecord, { nullable: true }),
    failureCode: { type: 'string', nullable: true },
    resultingBalance: nullableMoney,
    resultingBalanceCurrency: { type: 'string', nullable: true },
    completedAt: nullableTimestamp,
    referenceAttempts: { type: 'integer' },
    nextReferenceAttemptAt: nullableTimestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    wallet: foreignKey(() => WalletRecord),
    transaction: foreignKey(() => WagerTransactionRecord),
    direction: { type: 'string' },
    amount: money,
    currency: { type: 'string' },
    balanceBefore: money,
    balanceAfter: money,
    walletVersion: { type: 'integer' },
    createdAt: timestamp,
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string' },
    eventType: { type: 'string' },
    payload: { type: 'json' },
    occurredAt: timestamp,
    attempts: { type: 'integer' },
    nextAttemptAt: timestamp,
    publishedAt: nullableTimestamp,
    lastError: { type: 'string', nullable: true },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string' },
    receivedAt: timestamp,
    processedAt: nullableTimestamp,
  },
});

export const ENTITY_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  OutboxMessageSchema,
  InboxMessageSchema,
];
