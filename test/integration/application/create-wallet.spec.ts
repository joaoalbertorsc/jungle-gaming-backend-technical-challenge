import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { WalletAlreadyExistsError } from '../../../src/shared/application/application-errors';
import {
  assertLedgerMatchesBalance,
  count,
  createTestApplication,
  FailAt,
  httpContext,
  outboxEventTypes,
  type TestApplication,
} from '../../support/application';
import { rejectionOf } from '../../support/assertions';
import { TestDatabase } from '../../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const newPlayer = () => Bun.randomUUIDv7();

/** §9 POST /wallets: OPENING transaction and CREDIT entry in the same SQL transaction. */
describe('CreateWallet', () => {
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

  it('opens a wallet at version 1 with its initial balance', async () => {
    const playerId = newPlayer();

    const wallet = await app.createWallet.execute({
      playerId,
      initialBalance: brl('1000.00'),
      context: httpContext,
    });

    expect(wallet).toEqual({
      id: expect.any(String),
      playerId,
      balance: brl('1000.00'),
      version: 1,
    });
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('records the positive opening balance as an OPENING transaction, a CREDIT entry and an event', async () => {
    const wallet = await app.createWallet.execute({
      playerId: newPlayer(),
      initialBalance: brl('250.00'),
      context: httpContext,
    });

    const [opening] = await db.app`
      SELECT kind, status, provider_id, amount::text FROM wager_transactions WHERE wallet_id = ${wallet.id}`;
    expect(opening).toEqual({
      kind: 'OPENING',
      status: 'PROCESSED',
      provider_id: 'internal',
      amount: '250.00',
    });
    expect(await count(db.app, 'wallet_ledger_entries', { wallet_id: wallet.id })).toBe(1);
    expect(await outboxEventTypes(db.app, [wallet.id])).toEqual(['WalletBalanceChanged']);
  });

  it('opens a zero-balance wallet without transaction, ledger entry or event', async () => {
    const wallet = await app.createWallet.execute({
      playerId: newPlayer(),
      initialBalance: brl('0.00'),
      context: httpContext,
    });

    expect(wallet.balance).toEqual(brl('0.00'));
    expect(await count(db.app, 'wager_transactions', { wallet_id: wallet.id })).toBe(0);
    expect(await count(db.app, 'wallet_ledger_entries', { wallet_id: wallet.id })).toBe(0);
    expect(await outboxEventTypes(db.app, [wallet.id])).toEqual([]);
  });

  it('refuses a second wallet for the same player and currency', async () => {
    const playerId = newPlayer();
    await app.createWallet.execute({
      playerId,
      initialBalance: brl('10.00'),
      context: httpContext,
    });

    expect(
      await rejectionOf(
        app.createWallet.execute({ playerId, initialBalance: brl('99.00'), context: httpContext }),
      ),
    ).toBeInstanceOf(WalletAlreadyExistsError);
  });

  it('allows the same player another currency', async () => {
    const playerId = newPlayer();
    await app.createWallet.execute({
      playerId,
      initialBalance: brl('10.00'),
      context: httpContext,
    });

    const usd = await app.createWallet.execute({
      playerId,
      initialBalance: { amount: '5.00', currency: 'USD' },
      context: httpContext,
    });

    expect(usd.balance).toEqual({ amount: '5.00', currency: 'USD' });
  });

  it('is atomic: a failure before commit leaves no wallet, transaction, entry or event behind', async () => {
    const failing = await createTestApplication(db, { faults: new FailAt('wallet.before-commit') });
    const playerId = newPlayer();

    try {
      expect(
        await rejectionOf(
          failing.createWallet.execute({
            playerId,
            initialBalance: brl('100.00'),
            context: httpContext,
          }),
        ),
      ).toHaveProperty('message', expect.stringContaining('injected fault'));

      expect(await count(db.app, 'wallets', { player_id: playerId })).toBe(0);
      expect(await count(db.app, 'wager_transactions', { player_id: playerId })).toBe(0);
    } finally {
      await failing.close();
    }
  });
});
