import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { expectProblem, type RunningApi, startApi } from '../support/http';
import { TestDatabase } from '../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** §9 wallet endpoints: contract, status codes and Problem Details. */
describe('HTTP: wallets', () => {
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

  const createWallet = (body: unknown) => api.request('POST', '/wallets', { body });

  describe('POST /wallets', () => {
    it('201 with the wallet at version 1', async () => {
      const playerId = Bun.randomUUIDv7();

      const response = await createWallet({ playerId, initialBalance: brl('1000.00') });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        id: expect.any(String) as unknown,
        playerId,
        balance: brl('1000.00'),
        version: 1,
      });
    });

    it('409 WALLET_ALREADY_EXISTS for the same player and currency', async () => {
      const playerId = Bun.randomUUIDv7();
      await createWallet({ playerId, initialBalance: brl('10.00') });

      expectProblem(
        await createWallet({ playerId, initialBalance: brl('20.00') }),
        409,
        'WALLET_ALREADY_EXISTS',
      );
    });

    it.each([
      ['a missing playerId', { initialBalance: brl('1.00') }],
      ['a numeric amount', { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } }],
      ['an unknown field', { playerId: 'p', initialBalance: brl('1.00'), extra: true }],
    ])('400 VALIDATION_FAILED for %s', async (_label, body) => {
      const response = await createWallet(body);

      expectProblem(response, 400, 'VALIDATION_FAILED');
      expect(response.body.issues).toEqual(expect.any(Array) as unknown);
    });

    it('400 INVALID_MONEY for an amount with three decimals (never rounded)', async () => {
      expectProblem(
        await createWallet({ playerId: 'p', initialBalance: brl('10.005') }),
        400,
        'INVALID_MONEY',
      );
    });

    it('400 for a malformed JSON body', async () => {
      const response = await api.request('POST', '/wallets', { rawBody: '{"playerId":' });

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });
  });

  describe('GET /wallets/:walletId', () => {
    it('200 with balance and version', async () => {
      const created = await createWallet({
        playerId: Bun.randomUUIDv7(),
        initialBalance: brl('5.00'),
      });

      const response = await api.request('GET', `/wallets/${String(created.body.id)}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(created.body);
    });

    it('404 WALLET_NOT_FOUND for an unknown wallet', async () => {
      expectProblem(
        await api.request('GET', `/wallets/${Bun.randomUUIDv7()}`),
        404,
        'WALLET_NOT_FOUND',
      );
    });

    it('400 VALIDATION_FAILED for an id that is not a UUID', async () => {
      expectProblem(await api.request('GET', '/wallets/not-a-uuid'), 400, 'VALIDATION_FAILED');
    });
  });

  describe('GET /wallets/:walletId/ledger', () => {
    it('pages with a stable, opaque cursor', async () => {
      const created = await createWallet({
        playerId: Bun.randomUUIDv7(),
        initialBalance: brl('100.00'),
      });
      const id = String(created.body.id);

      const first = await api.request('GET', `/wallets/${id}/ledger?limit=1`);

      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        entries: [{ direction: 'CREDIT', walletVersion: 1, balanceAfter: brl('100.00') }],
        nextCursor: null,
      });
    });

    it('400 INVALID_CURSOR for a tampered cursor', async () => {
      const created = await createWallet({
        playerId: Bun.randomUUIDv7(),
        initialBalance: brl('1.00'),
      });

      expectProblem(
        await api.request('GET', `/wallets/${String(created.body.id)}/ledger?cursor=abc`),
        400,
        'INVALID_CURSOR',
      );
    });

    it.each(['0', '201', 'ten'])('400 VALIDATION_FAILED for limit=%s', async (limit) => {
      expectProblem(
        await api.request('GET', `/wallets/${Bun.randomUUIDv7()}/ledger?limit=${limit}`),
        400,
        'VALIDATION_FAILED',
      );
    });
  });

  describe('POST /wallets/:walletId/reconciliation', () => {
    it('200 with the reconciliation report', async () => {
      const created = await createWallet({
        playerId: Bun.randomUUIDv7(),
        initialBalance: brl('42.00'),
      });
      const id = String(created.body.id);

      const response = await api.request('POST', `/wallets/${id}/reconciliation`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        walletId: id,
        storedBalance: brl('42.00'),
        calculatedBalance: brl('42.00'),
        difference: brl('0.00'),
        consistent: true,
        checkedEntries: 1,
      });
    });
  });
});
