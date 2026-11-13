import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { expectProblem, type RunningApi, startApi } from '../support/http';
import { TestDatabase } from '../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/**
 * §9 POST /wagering/transactions: the five situations a provider must tell apart by status code
 * alone, consistently (ADR-0009).
 */
describe('HTTP: wagering', () => {
  let db: TestDatabase;
  let api: RunningApi;

  beforeAll(async () => {
    db = await TestDatabase.create();
    api = await startApi(db, { DB_LOCK_TIMEOUT_MS: '300' });
  });

  afterAll(async () => {
    await api.close();
    await db.drop();
  });

  async function openWallet(balance: string) {
    const response = await api.request('POST', '/wallets', {
      body: { playerId: Bun.randomUUIDv7(), initialBalance: brl(balance) },
    });
    return response.body as { id: string; playerId: string };
  }

  function payload(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
    return {
      providerId: 'provider-a',
      externalTransactionId: `tx-${Bun.randomUUIDv7()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl('25.00'),
      ...overrides,
    };
  }

  const submit = (body: Record<string, unknown>, key?: string) =>
    api.request('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': key ?? `provider-a:${String(body.externalTransactionId)}` },
    });

  it('201 PROCESSED for a new transaction', async () => {
    const wallet = await openWallet('1000.00');

    const response = await submit(payload(wallet));

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      transactionId: expect.any(String) as unknown,
      status: 'PROCESSED',
      balance: brl('975.00'),
      idempotentReplay: false,
    });
  });

  it('200 with idempotentReplay for an identical request', async () => {
    const wallet = await openWallet('1000.00');
    const body = payload(wallet);
    const first = await submit(body);

    const replay = await submit(body);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('409 IDEMPOTENCY_CONFLICT for the same key with another payload', async () => {
    const wallet = await openWallet('1000.00');
    const body = payload(wallet);
    await submit(body);

    const response = await submit({ ...body, money: brl('26.00') });

    expectProblem(response, 409, 'IDEMPOTENCY_CONFLICT');
    expect(response.body.reason).toBe('PAYLOAD_MISMATCH');
  });

  it('422 REJECTED with a failure code for a business rule violation', async () => {
    const wallet = await openWallet('20.00');

    const response = await submit(payload(wallet, { money: brl('80.00') }));

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('20.00'),
      idempotentReplay: false,
    });
  });

  it('keeps 422 when a rejected request is replayed', async () => {
    const wallet = await openWallet('20.00');
    const body = payload(wallet, { money: brl('80.00') });
    await submit(body);

    const replay = await submit(body);

    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ status: 'REJECTED', idempotentReplay: true });
  });

  it('202 PENDING_REFERENCE when the reference has not arrived', async () => {
    const wallet = await openWallet('100.00');

    const response = await submit(
      payload(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-not-yet' }),
    );

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE' });
  });

  it('422 WALLET_NOT_FOUND for an unknown wallet', async () => {
    expectProblem(
      await submit(payload({ id: Bun.randomUUIDv7(), playerId: 'nobody' })),
      422,
      'WALLET_NOT_FOUND',
    );
  });

  describe('invalid payloads → 400', () => {
    it('requires the Idempotency-Key header', async () => {
      const wallet = await openWallet('10.00');

      const response = await api.request('POST', '/wagering/transactions', {
        body: payload(wallet),
      });

      expectProblem(response, 400, 'IDEMPOTENCY_KEY_REQUIRED');
    });

    it.each([
      ['OPENING kind', { kind: 'OPENING' }],
      ['unknown kind', { kind: 'JACKPOT' }],
      ['numeric amount', { money: { amount: 25, currency: 'BRL' } }],
      ['non-UUID walletId', { walletId: 'wallet-1' }],
    ])('rejects %s with VALIDATION_FAILED', async (_label, overrides) => {
      const wallet = await openWallet('10.00');

      expectProblem(await submit(payload(wallet, overrides)), 400, 'VALIDATION_FAILED');
    });

    it('rejects a REFUND without reference as INVALID_WAGER_TRANSACTION', async () => {
      const wallet = await openWallet('10.00');

      const response = await submit(payload(wallet, { kind: 'REFUND' }));

      expectProblem(response, 400, 'INVALID_WAGER_TRANSACTION');
      expect(response.body.reason).toBe('REFERENCE_REQUIRED');
    });

    it('rejects scientific notation as INVALID_MONEY', async () => {
      const wallet = await openWallet('10.00');

      expectProblem(
        await submit(payload(wallet, { money: brl('1e2') })),
        400,
        'INVALID_MONEY',
      );
    });
  });

  it('503 TEMPORARILY_UNAVAILABLE with Retry-After when the wallet stays locked', async () => {
    const wallet = await openWallet('100.00');
    const holder = await db.app.reserve();

    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;

      const response = await submit(payload(wallet));

      expectProblem(response, 503, 'TEMPORARILY_UNAVAILABLE');
      expect(response.headers.get('retry-after')).toBe('1');
    } finally {
      await holder`ROLLBACK`;
      await holder.release();
    }
  });

  describe('lookups', () => {
    it('GET /wagering/transactions/:id and the provider lookup return the same transaction', async () => {
      const wallet = await openWallet('100.00');
      const body = payload(wallet);
      const created = await submit(body);

      const byId = await api.request(
        'GET',
        `/wagering/transactions/${String(created.body.transactionId)}`,
      );
      const byProvider = await api.request(
        'GET',
        `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
      );

      expect(byId.status).toBe(200);
      expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: brl('25.00') });
      expect(byProvider.body).toEqual(byId.body);
    });

    it('404 TRANSACTION_NOT_FOUND for unknown transactions', async () => {
      expectProblem(
        await api.request('GET', `/wagering/transactions/${Bun.randomUUIDv7()}`),
        404,
        'TRANSACTION_NOT_FOUND',
      );
      expectProblem(
        await api.request('GET', '/providers/provider-a/wagering/transactions/never-sent'),
        404,
        'TRANSACTION_NOT_FOUND',
      );
    });
  });
});
