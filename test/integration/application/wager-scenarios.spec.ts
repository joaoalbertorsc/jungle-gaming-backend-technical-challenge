import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { SubmitWagerTransactionCommand } from '../../../src/modules/wagering/application/submit-wager-transaction';
import { FailureCode } from '../../../src/modules/wagering/domain/failure-code';
import { LedgerDirection } from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import { WagerTransactionStatus as Status } from '../../../src/modules/wagering/domain/wager-transaction';
import {
  assertLedgerMatchesBalance,
  createTestApplication,
  httpContext,
  type TestApplication,
} from '../../support/application';
import {
  createTestRetryWorker,
  deferAllPendingReferences,
  pendingRow,
} from '../../support/retry-worker';
import { TestDatabase } from '../../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

interface WalletRef {
  readonly id: string;
  readonly playerId: string;
}

/**
 * Scenarios beyond the mandatory list that a real provider integration hits: a whole round with
 * reversals, races between reversals, a hot wallet overbooked, late references that end badly, and
 * ledger pagination while the wallet keeps moving.
 */
describe('wager scenarios', () => {
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

  beforeEach(() => deferAllPendingReferences(db.app));

  const openWallet = (balance: string): Promise<WalletRef> =>
    app.createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: brl(balance),
      context: httpContext,
    });

  function submit(
    wallet: WalletRef,
    kind: string,
    amount: string,
    options: { id?: string; reference?: string } = {},
  ) {
    const externalTransactionId = options.id ?? `${kind.toLowerCase()}-${Bun.randomUUIDv7()}`;
    const command: SubmitWagerTransactionCommand = {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: brl(amount),
      referenceExternalTransactionId: options.reference,
      context: httpContext,
    };
    return app.submit.execute(command);
  }

  const balanceOf = async (wallet: WalletRef) => (await app.getWallet.execute(wallet.id)).balance;

  async function ledgerOf(wallet: WalletRef) {
    return (await app.getLedger.execute({ walletId: wallet.id, limit: 200 })).entries;
  }

  it('a whole round: BET, WIN, LOSS, ROLLBACK of the WIN, REFUND of the BET, then a second REFUND', async () => {
    const wallet = await openWallet('100.00');

    const bet = await submit(wallet, 'BET', '25.00', { id: `bet-${Bun.randomUUIDv7()}` });
    const betId = (await app.getTransaction.byId(bet.transactionId)).externalTransactionId;
    const win = await submit(wallet, 'WIN', '40.00', { reference: betId });
    const winId = (await app.getTransaction.byId(win.transactionId)).externalTransactionId;
    const loss = await submit(wallet, 'LOSS', '0', { reference: betId });
    const rollback = await submit(wallet, 'ROLLBACK', '40.00', { reference: winId });
    const refund = await submit(wallet, 'REFUND', '25.00', { reference: betId });
    const secondRefund = await submit(wallet, 'REFUND', '25.00', { reference: betId });

    expect([bet, win, loss, rollback, refund].map((o) => [o.status, o.balance.amount])).toEqual([
      ['PROCESSED', '75.00'],
      ['PROCESSED', '115.00'],
      ['PROCESSED', '115.00'],
      ['PROCESSED', '75.00'],
      ['PROCESSED', '100.00'],
    ]);
    expect(secondRefund).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });

    // One gap-free chain: opening, then one entry per balance move (LOSS has none).
    const ledger = await ledgerOf(wallet);
    expect(ledger.map((e) => [e.walletVersion, e.direction, e.balanceAfter.amount])).toEqual([
      [1, 'CREDIT', '100.00'],
      [2, 'DEBIT', '75.00'],
      [3, 'CREDIT', '115.00'],
      [4, 'DEBIT', '75.00'],
      [5, 'CREDIT', '100.00'],
    ]);
    expect(await balanceOf(wallet)).toEqual(brl('100.00'));
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('a REFUND and a ROLLBACK of the same BET racing each other: exactly one reverses it', async () => {
    const wallets = await Promise.all(range(5).map(() => openWallet('100.00')));

    for (const wallet of wallets) {
      const betId = `bet-${Bun.randomUUIDv7()}`;
      await submit(wallet, 'BET', '30.00', { id: betId });

      const outcomes = await Promise.all([
        submit(wallet, 'REFUND', '30.00', { reference: betId }),
        submit(wallet, 'ROLLBACK', '30.00', { reference: betId }),
      ]);

      expect(outcomes.map((o) => o.status).sort()).toEqual([Status.Processed, Status.Rejected]);
      expect(outcomes.find((o) => o.status === Status.Rejected)?.failureCode).toBe(
        FailureCode.AlreadyReversed,
      );
      expect(await balanceOf(wallet)).toEqual(brl('100.00'));
      expect(
        (await ledgerOf(wallet)).filter((e) => e.direction === LedgerDirection.Credit),
      ).toHaveLength(2);
      await assertLedgerMatchesBalance(db.app, wallet.id);
    }
  });

  it('a hot wallet overbooked: 15 concurrent 10.00 bets on 100.00 → 10 processed, 5 rejected, 0.00', async () => {
    const wallet = await openWallet('100.00');

    const outcomes = await Promise.all(range(15).map(() => submit(wallet, 'BET', '10.00')));

    expect(outcomes.filter((o) => o.status === Status.Processed)).toHaveLength(10);
    const rejected = outcomes.filter((o) => o.status === Status.Rejected);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((o) => o.failureCode === FailureCode.InsufficientFunds)).toBe(true);
    // Every balance any request observed stayed within [0, 100].
    for (const outcome of outcomes) {
      expect(Number(outcome.balance.amount)).toBeGreaterThanOrEqual(0);
    }
    expect(await balanceOf(wallet)).toEqual(brl('0.00'));
    expect(
      (await ledgerOf(wallet)).filter((e) => e.direction === LedgerDirection.Debit),
    ).toHaveLength(10);
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('a REFUND waiting for a BET that ends REJECTED is rejected as REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await openWallet('10.00');
    const betId = `bet-${Bun.randomUUIDv7()}`;
    const refund = await submit(wallet, 'REFUND', '25.00', { reference: betId });
    expect(refund.status).toBe(Status.PendingReference);

    const bet = await submit(wallet, 'BET', '25.00', { id: betId }); // more than the balance
    expect(bet).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });

    const round = await createTestRetryWorker(app).retryOnce(); // the BET's decision nudged it
    expect(round.rejected).toEqual([refund.transactionId]);
    expect(await pendingRow(db.app, refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_PROCESSED',
    });
    expect(await balanceOf(wallet)).toEqual(brl('10.00'));
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('a WIN delivered before its BET waits, then credits once the BET arrives', async () => {
    const wallet = await openWallet('100.00');
    const betId = `bet-${Bun.randomUUIDv7()}`;
    const win = await submit(wallet, 'WIN', '40.00', { reference: betId });
    expect(win.status).toBe(Status.PendingReference);

    await submit(wallet, 'BET', '25.00', { id: betId });
    const round = await createTestRetryWorker(app).retryOnce();

    expect(round.processed).toEqual([win.transactionId]);
    expect(await balanceOf(wallet)).toEqual(brl('115.00'));
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('ledger pagination stays stable while new entries are appended between pages', async () => {
    const wallet = await openWallet('1000.00');
    for (let i = 0; i < 6; i++) await submit(wallet, 'BET', '1.00');

    const versions: number[] = [];
    let page = await app.getLedger.execute({ walletId: wallet.id, limit: 3 });
    versions.push(...page.entries.map((e) => e.walletVersion));
    for (let i = 0; i < 4; i++) await submit(wallet, 'BET', '1.00'); // the wallet keeps moving

    while (page.nextCursor !== null) {
      page = await app.getLedger.execute({
        walletId: wallet.id,
        limit: 3,
        cursor: page.nextCursor,
      });
      versions.push(...page.entries.map((e) => e.walletVersion));
    }

    // Nothing skipped, nothing repeated, and the entries appended mid-way are included.
    expect(versions).toEqual(range(11).map((i) => i + 1));
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });
});
