import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  InvalidCursorError,
  ResourceNotFoundError,
} from '../../../src/shared/application/application-errors';
import {
  createTestApplication,
  httpContext,
  type TestApplication,
} from '../../support/application';
import { rejectionOf } from '../../support/assertions';
import { TestDatabase } from '../../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** §9 queries and reconciliation. */
describe('queries and reconciliation', () => {
  let db: TestDatabase;
  let app: TestApplication;

  beforeAll(async () => {
    db = await TestDatabase.create();
    app = await createTestApplication(db);
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  async function walletWithBets(bets: readonly string[]) {
    const wallet = await app.createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: brl('100.00'),
      context: httpContext,
    });
    const transactions = [];
    for (const amount of bets) {
      const externalTransactionId = `q-${Bun.randomUUIDv7()}`;
      transactions.push(
        await app.submit.execute({
          idempotencyKey: `provider-a:${externalTransactionId}`,
          providerId: 'provider-a',
          externalTransactionId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: brl(amount),
          context: httpContext,
        }),
      );
    }
    return { wallet, transactions };
  }

  describe('GetWallet', () => {
    it('returns balance and version', async () => {
      const { wallet } = await walletWithBets(['10.00']);

      expect(await app.getWallet.execute(wallet.id)).toEqual({
        id: wallet.id,
        playerId: wallet.playerId,
        balance: brl('90.00'),
        version: 2,
      });
    });

    it('raises a not-found error for an unknown wallet', async () => {
      expect(await rejectionOf(app.getWallet.execute(Bun.randomUUIDv7()))).toBeInstanceOf(
        ResourceNotFoundError,
      );
    });
  });

  describe('GetWalletLedger', () => {
    it('pages through the ledger in version order with an opaque cursor', async () => {
      const { wallet } = await walletWithBets(['10.00', '20.00']);

      const first = await app.getLedger.execute({ walletId: wallet.id, limit: 2 });
      const second = await app.getLedger.execute({
        walletId: wallet.id,
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });

      expect(
        first.entries.map((e) => [e.walletVersion, e.direction, e.balanceAfter.amount]),
      ).toEqual([
        [1, 'CREDIT', '100.00'],
        [2, 'DEBIT', '90.00'],
      ]);
      expect(typeof first.nextCursor).toBe('string');
      expect(second.entries.map((e) => e.balanceAfter.amount)).toEqual(['70.00']);
      expect(second.nextCursor).toBeNull();
    });

    it('rejects a malformed cursor', async () => {
      const { wallet } = await walletWithBets([]);

      expect(
        await rejectionOf(
          app.getLedger.execute({ walletId: wallet.id, limit: 10, cursor: 'bogus!' }),
        ),
      ).toBeInstanceOf(InvalidCursorError);
    });

    it('raises a not-found error for an unknown wallet', async () => {
      expect(
        await rejectionOf(app.getLedger.execute({ walletId: Bun.randomUUIDv7(), limit: 10 })),
      ).toBeInstanceOf(ResourceNotFoundError);
    });
  });

  describe('GetWagerTransaction', () => {
    it('finds a transaction by internal id and by provider id + external id', async () => {
      const { transactions } = await walletWithBets(['10.00']);
      const transactionId = transactions[0]!.transactionId;

      const byId = await app.getTransaction.byId(transactionId);
      const byProvider = await app.getTransaction.byProviderExternalId(
        'provider-a',
        byId.externalTransactionId,
      );

      expect(byId).toMatchObject({
        id: transactionId,
        kind: 'BET',
        status: 'PROCESSED',
        money: brl('10.00'),
        resultingBalance: brl('90.00'),
      });
      expect(byProvider).toEqual(byId);
    });

    it('raises a not-found error for unknown transactions', async () => {
      expect(await rejectionOf(app.getTransaction.byId(Bun.randomUUIDv7()))).toBeInstanceOf(
        ResourceNotFoundError,
      );
      expect(
        await rejectionOf(app.getTransaction.byProviderExternalId('provider-a', 'never-sent')),
      ).toBeInstanceOf(ResourceNotFoundError);
    });
  });

  describe('ReconcileWallet', () => {
    it('reports a consistent wallet', async () => {
      const { wallet } = await walletWithBets(['25.00', '0.01']);

      expect(await app.reconcile.execute(wallet.id)).toEqual({
        walletId: wallet.id,
        storedBalance: brl('74.99'),
        calculatedBalance: brl('74.99'),
        difference: brl('0.00'),
        consistent: true,
        checkedEntries: 3,
      });
    });

    it('flags, logs and counts a divergence without correcting it', async () => {
      const { wallet } = await walletWithBets(['10.00']);
      // Simulate corruption the schema forbids: the owner disables the user triggers for one update.
      await db.owner.begin(async (tx) => {
        await tx`ALTER TABLE wallets DISABLE TRIGGER USER`;
        await tx`UPDATE wallets SET balance = '95.00' WHERE id = ${wallet.id}`;
        await tx`ALTER TABLE wallets ENABLE TRIGGER USER`;
      });

      const report = await app.reconcile.execute(wallet.id);

      expect(report).toMatchObject({
        storedBalance: brl('95.00'),
        calculatedBalance: brl('90.00'),
        difference: brl('5.00'),
        consistent: false,
      });
      expect(app.metrics.calls).toContain('reconciliation-mismatch');
      expect(app.logger.entries.some((e) => e.level === 'error')).toBe(true);
      const [row] = await db.app`SELECT balance::text FROM wallets WHERE id = ${wallet.id}`;
      expect(row).toEqual({ balance: '95.00' });
    });

    it('raises a not-found error for an unknown wallet', async () => {
      expect(await rejectionOf(app.reconcile.execute(Bun.randomUUIDv7()))).toBeInstanceOf(
        ResourceNotFoundError,
      );
    });
  });
});
