import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type RunningApi, startApi } from '../support/http';
import { TestDatabase } from '../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

interface WalletRef {
  readonly id: string;
  readonly playerId: string;
}

/**
 * HTTP scenarios beyond the mandatory list: what "identical request" means for the payload hash, the
 * money formats a provider may send, wallet/player/currency mix-ups, and correlation reaching events.
 */
describe('wagering scenarios over HTTP', () => {
  let db: TestDatabase;
  let api: RunningApi;

  beforeAll(async () => {
    db = await TestDatabase.create();
    api = await startApi(db);
  });

  afterAll(async () => {
    await api.close();
    await db.drop();
  });

  async function openWallet(balance = '100.00', currency = 'BRL'): Promise<WalletRef> {
    const response = await api.request('POST', '/wallets', {
      body: {
        playerId: `player-${Bun.randomUUIDv7()}`,
        initialBalance: { amount: balance, currency },
      },
    });
    expect(response.status).toBe(201);
    return { id: String(response.body.id), playerId: String(response.body.playerId) };
  }

  function betBody(wallet: WalletRef, externalTransactionId: string, money: unknown) {
    return {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money,
    };
  }

  const submit = (
    key: string,
    options: { body?: unknown; rawBody?: string; correlationId?: string },
  ) =>
    api.request('POST', '/wagering/transactions', {
      headers: {
        'Idempotency-Key': key,
        ...(options.correlationId === undefined
          ? {}
          : { 'X-Correlation-Id': options.correlationId }),
      },
      ...(options.rawBody === undefined ? { body: options.body } : { rawBody: options.rawBody }),
    });

  const balanceOf = async (wallet: WalletRef) =>
    (await api.request('GET', `/wallets/${wallet.id}`)).body.balance;

  describe('what counts as the same request (canonical payload hash, §9)', () => {
    it('"25" and "25.00" are the same amount: the second request is a replay, not a conflict', async () => {
      const wallet = await openWallet();
      const id = `canon-${Bun.randomUUIDv7()}`;

      const first = await submit(`provider-a:${id}`, { body: betBody(wallet, id, brl('25')) });
      const second = await submit(`provider-a:${id}`, { body: betBody(wallet, id, brl('25.00')) });

      expect(first.status).toBe(201);
      expect(first.body.balance).toEqual(brl('75.00'));
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({
        transactionId: first.body.transactionId,
        idempotentReplay: true,
      });
      expect(await balanceOf(wallet)).toEqual(brl('75.00'));
    });

    it('key order and whitespace in the JSON body do not change the payload', async () => {
      const wallet = await openWallet();
      const id = `order-${Bun.randomUUIDv7()}`;
      const body = betBody(wallet, id, brl('10.00'));
      const reordered = Object.fromEntries(Object.entries(body).reverse());

      const first = await submit(`provider-a:${id}`, { body });
      const second = await submit(`provider-a:${id}`, {
        rawBody: JSON.stringify(reordered, null, 4),
      });

      expect(second.status).toBe(200);
      expect(second.body.transactionId).toBe(first.body.transactionId);
    });

    it('a different round under the same key is a conflict, never a replay', async () => {
      const wallet = await openWallet();
      const id = `round-${Bun.randomUUIDv7()}`;
      await submit(`provider-a:${id}`, { body: betBody(wallet, id, brl('10.00')) });

      const other = await submit(`provider-a:${id}`, {
        body: { ...betBody(wallet, id, brl('10.00')), roundId: 'round-2' },
      });

      expect(other.status).toBe(409);
      expect(other.body).toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        reason: 'PAYLOAD_MISMATCH',
      });
      expect(await balanceOf(wallet)).toEqual(brl('90.00'));
    });
  });

  describe('money formats', () => {
    it('accepts 0 to 2 decimals and always answers with exactly 2', async () => {
      const wallet = await openWallet('100');
      expect(await balanceOf(wallet)).toEqual(brl('100.00'));

      const cent = await submit(`provider-a:cent-${wallet.id}`, {
        body: betBody(wallet, `cent-${wallet.id}`, brl('0.01')),
      });
      const half = await submit(`provider-a:half-${wallet.id}`, {
        body: betBody(wallet, `half-${wallet.id}`, brl('25.5')),
      });

      expect([cent.body.balance, half.body.balance]).toEqual([brl('99.99'), brl('74.49')]);
    });

    it.each([
      ['a negative amount', '-1.00'],
      ['a zero BET', '0.00'],
      ['an amount with a thousands separator', '1,000.00'],
    ])('rejects %s with 400 and moves no money', async (_case, amount) => {
      const wallet = await openWallet();
      const id = `bad-${Bun.randomUUIDv7()}`;

      const response = await submit(`provider-a:${id}`, { body: betBody(wallet, id, brl(amount)) });

      expect(response.status).toBe(400);
      expect(await balanceOf(wallet)).toEqual(brl('100.00'));
    });
  });

  describe('wallet, player and currency mix-ups', () => {
    it('a BET in another currency than the wallet is rejected (422) without touching the balance', async () => {
      const wallet = await openWallet();
      const id = `usd-${Bun.randomUUIDv7()}`;

      const response = await submit(`provider-a:${id}`, {
        body: betBody(wallet, id, { amount: '10.00', currency: 'USD' }),
      });

      expect(response.status).toBe(422);
      expect(response.body.failureCode ?? response.body.code).toBe('CURRENCY_MISMATCH');
      expect(await balanceOf(wallet)).toEqual(brl('100.00'));
    });

    it("a BET naming another player than the wallet's owner is rejected (422)", async () => {
      const wallet = await openWallet();
      const id = `player-${Bun.randomUUIDv7()}`;

      const response = await submit(`provider-a:${id}`, {
        body: { ...betBody(wallet, id, brl('10.00')), playerId: 'someone-else' },
      });

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'WALLET_PLAYER_MISMATCH',
      });
      expect(await balanceOf(wallet)).toEqual(brl('100.00'));
    });

    it('the same player keeps independent wallets per currency', async () => {
      const playerId = `player-${Bun.randomUUIDv7()}`;
      const open = (currency: string) =>
        api.request('POST', '/wallets', {
          body: { playerId, initialBalance: { amount: '50.00', currency } },
        });
      const [brlWallet, usdWallet] = await Promise.all([open('BRL'), open('USD')]);
      const usd = { id: String(usdWallet.body.id), playerId };
      const id = `usd-bet-${Bun.randomUUIDv7()}`;

      await submit(`provider-a:${id}`, {
        body: betBody(usd, id, { amount: '20.00', currency: 'USD' }),
      });

      expect(await balanceOf(usd)).toEqual({ amount: '30.00', currency: 'USD' });
      expect(await balanceOf({ id: String(brlWallet.body.id), playerId })).toEqual(brl('50.00'));
    });
  });

  it('the X-Correlation-Id of a request reaches the events it produced', async () => {
    const wallet = await openWallet();
    const id = `corr-${Bun.randomUUIDv7()}`;

    const response = await submit(`provider-a:${id}`, {
      body: betBody(wallet, id, brl('10.00')),
      correlationId: 'corr-reaches-events',
    });

    const events: { event_type: string; correlation: string }[] = await db.app`
      SELECT event_type, payload->>'correlationId' AS correlation FROM outbox_messages
      WHERE aggregate_id IN (${String(response.body.transactionId)}, ${wallet.id})
        AND payload->>'correlationId' = 'corr-reaches-events'
      ORDER BY event_type`;
    expect(events.map((e) => e.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });
});
