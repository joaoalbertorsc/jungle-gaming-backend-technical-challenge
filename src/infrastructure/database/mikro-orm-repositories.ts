import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import type { InboxRepository, OutboxRepository } from '../../modules/messaging/application/ports';
import type { InboxMessage } from '../../modules/messaging/domain/inbox-message';
import type { OutboxMessage } from '../../modules/messaging/domain/outbox-message';
import type { WagerTransactionRepository } from '../../modules/wagering/application/ports';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../modules/wagering/domain/wager-transaction';
import type {
  LedgerRepository,
  LedgerSummary,
  WalletRepository,
} from '../../modules/wallet/application/ports';
import type { Wallet } from '../../modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../modules/wallet/domain/wallet-ledger-entry';
import type { Repositories } from '../../shared/application/unit-of-work';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './entities';
import {
  inboxMessageFromRecord,
  inboxMessageToRecord,
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
  outboxMessageToRecord,
  signedMoney,
  transactionFromRecord,
  transactionOutcomeColumns,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from './mappers';

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record === null ? undefined : walletFromRecord(record);
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id });
    return record === null ? undefined : walletFromRecord(record);
  }

  add(wallet: Wallet): void {
    this.em.persist(this.em.create(WalletRecord, walletToRecord(wallet)));
  }

  save(wallet: Wallet): void {
    // The record is already managed (loaded by lockById); the Unit of Work diffs it at flush.
    const record = this.em.getReference(WalletRecord, wallet.id);
    record.balance = wallet.balance.amount;
    record.version = wallet.version;
    record.updatedAt = wallet.updatedAt;
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  append(entry: WalletLedgerEntry): void {
    this.em.persist(this.em.create(LedgerEntryRecord, ledgerEntryToRecord(entry)));
  }

  async page(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntryRecord,
      { wallet: walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit },
    );
    return records.map(ledgerEntryFromRecord);
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const rows: { balance: string; entries: number }[] = await this.em.execute(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS balance,
              count(*)::int AS entries
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    const row = rows[0] ?? { balance: '0', entries: 0 };
    return { balance: signedMoney(row.balance, currency), entries: row.entries };
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.one(await this.em.findOne(WagerTransactionRecord, { id }));
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.one(await this.em.findOne(WagerTransactionRecord, { idempotencyKey }));
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.one(
      await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }),
    );
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const reversals = await this.em.count(WagerTransactionRecord, {
      referenceTransaction: referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return reversals > 0;
  }

  add(transaction: WagerTransaction, options: { nextReferenceAttemptAt?: Date } = {}): void {
    this.em.persist(
      this.em.create(WagerTransactionRecord, transactionToRecord(transaction, options)),
    );
  }

  save(transaction: WagerTransaction): void {
    const record = this.em.getReference(WagerTransactionRecord, transaction.id);
    Object.assign(record, transactionOutcomeColumns(transaction), {
      updatedAt: transaction.completedAt ?? new Date(),
    });
  }

  async nudgeWaitingOn(
    providerId: string,
    externalTransactionId: string,
    at: Date,
  ): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        status: WagerTransactionStatus.PendingReference,
        providerId,
        referenceExternalTransactionId: externalTransactionId,
      },
      { nextReferenceAttemptAt: at, updatedAt: at },
    );
  }

  private one(record: WagerTransactionRecord | null): WagerTransaction | undefined {
    return record === null ? undefined : transactionFromRecord(record);
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  enqueue(...messages: OutboxMessage[]): void {
    for (const message of messages) {
      this.em.persist(this.em.create(OutboxMessageRecord, outboxMessageToRecord(message)));
    }
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId });
    return record === null ? undefined : inboxMessageFromRecord(record);
  }

  record(message: InboxMessage): void {
    this.em.persist(this.em.create(InboxMessageRecord, inboxMessageToRecord(message)));
  }
}

export function mikroOrmRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}
