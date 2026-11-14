import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { assertEveryWalletConsistent, assertLedgerMatchesBalance } from '../support/application';
import { type RoleProcess, ProcessGroup } from '../support/processes';
import { createIsolatedQueues, type IsolatedQueues } from '../support/queues';
import { TestDatabase } from '../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

interface WalletRef {
  readonly id: string;
  readonly playerId: string;
}

/**
 * §13 scenarios 1 to 4 over HTTP, with real parallelism: three `api` processes (separate OS
 * processes, separate connection pools) on one PostgreSQL database.
 */
describe('concurrency: three API processes on one database', () => {
  let db: TestDatabase;
  let queues: IsolatedQueues;
  let group: ProcessGroup;
  let apis: RoleProcess[];

  beforeAll(async () => {
    db = await TestDatabase.create();
    queues = await createIsolatedQueues();
    // Contention here is the point: wait for the wallet lock rather than answer 503.
    group = new ProcessGroup({
      DATABASE_URL: db.appUrl,
      DB_LOCK_TIMEOUT_MS: '10000',
      ...queues.env,
    });
    apis = await Promise.all(range(3).map(() => group.spawn('api')));
  });

  afterAll(async () => {
    await group.killAll();
    await queues.destroy();
    await db.drop();
  });

  // The final invariant of every scenario, over every wallet in the database.
  afterEach(() => assertEveryWalletConsistent(db.app));

  const api = (i: number): RoleProcess => apis[i % apis.length]!;

  async function openWallet(balance = '100.00'): Promise<WalletRef> {
    const response = await api(0).request('POST', '/wallets', {
      body: { playerId: Bun.randomUUIDv7(), initialBalance: brl(balance) },
    });
    expect(response.status).toBe(201);
    return { id: String(response.body.id), playerId: String(response.body.playerId) };
  }

  function bet(instance: number, wallet: WalletRef, externalTransactionId: string, amount: string) {
    return api(instance).request('POST', '/wagering/transactions', {
      headers: { 'Idempotency-Key': `provider-a:${externalTransactionId}` },
      body: {
        providerId: 'provider-a',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: brl(amount),
      },
    });
  }

  async function balanceOf(wallet: WalletRef) {
    return (await api(0).request('GET', `/wallets/${wallet.id}`)).body.balance;
  }

  async function debitsOf(wallet: WalletRef): Promise<number> {
    const [row] = await db.app`
      SELECT count(*)::int AS n FROM wallet_ledger_entries
      WHERE wallet_id = ${wallet.id} AND direction = 'DEBIT'`;
    return (row as { n: number }).n;
  }

  it('scenario 1: the same bet sent 50 times in parallel debits the wallet once', async () => {
    const wallet = await openWallet();
    const externalId = `same-bet-${Bun.randomUUIDv7()}`;

    const responses = await Promise.all(range(50).map((i) => bet(i, wallet, externalId, '10.00')));

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 200)).toHaveLength(49);
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(await debitsOf(wallet)).toBe(1);
    expect(await balanceOf(wallet)).toEqual(brl('90.00'));
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });

  it('scenario 2 (§8): two simultaneous 80.00 bets on 100.00 → one PROCESSED, one REJECTED, 20.00', async () => {
    // Repeated on several wallets at once, each pair split across two instances.
    const wallets = await Promise.all(range(5).map(() => openWallet('100.00')));

    await Promise.all(
      wallets.map(async (wallet, i) => {
        const ids = [`a-${Bun.randomUUIDv7()}`, `b-${Bun.randomUUIDv7()}`];
        const send = () =>
          Promise.all([bet(i, wallet, ids[0]!, '80.00'), bet(i + 1, wallet, ids[1]!, '80.00')]);

        const first = await send();
        const retried = await send(); // a retry of both requests must not move money again

        expect(first.map((r) => r.status).sort()).toEqual([201, 422]);
        expect(first.find((r) => r.status === 422)?.body).toMatchObject({
          status: 'REJECTED',
          failureCode: 'INSUFFICIENT_FUNDS',
        });
        expect(retried.map((r) => r.body.transactionId)).toEqual(
          first.map((r) => r.body.transactionId),
        );
        expect(await debitsOf(wallet)).toBe(1);
        expect(await balanceOf(wallet)).toEqual(brl('20.00'));
        await assertLedgerMatchesBalance(db.app, wallet.id);
      }),
    );
  });

  it('scenario 3: a locked wallet never blocks another wallet (no global lock)', async () => {
    const [busy, free] = await Promise.all([openWallet(), openWallet()]);

    // Hold the busy wallet's row lock from outside, as a slow transaction would.
    let release!: () => void;
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.app.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${busy.id} FOR UPDATE`;
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await lockTaken;

    const blocked = bet(0, busy, `busy-${Bun.randomUUIDv7()}`, '10.00');
    const started = performance.now();
    const unblocked = await bet(1, free, `free-${Bun.randomUUIDv7()}`, '10.00');
    const elapsed = performance.now() - started;
    const stillWaiting = await Promise.race([
      blocked.then(() => false),
      Bun.sleep(300).then(() => true),
    ]);
    release();
    await holder;

    expect(unblocked.status).toBe(201);
    expect(elapsed).toBeLessThan(1_000);
    expect(stillWaiting).toBe(true);
    expect((await blocked).status).toBe(201);
  });

  it('scenario 3: many wallets in parallel across instances each end with the exact balance', async () => {
    const wallets = await Promise.all(range(20).map(() => openWallet('100.00')));

    const responses = await Promise.all(
      wallets.flatMap((wallet, w) =>
        range(5).map((i) => bet(w + i, wallet, `par-${Bun.randomUUIDv7()}`, '10.00')),
      ),
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);
    for (const wallet of wallets) {
      expect(await balanceOf(wallet)).toEqual(brl('50.00'));
      expect(await debitsOf(wallet)).toBe(5);
    }
  });

  it('scenario 4: all three instances serve the same wallet at once without losing an update', async () => {
    const wallet = await openWallet('300.00');

    const responses = await Promise.all(
      range(60).map((i) => bet(i, wallet, `multi-${Bun.randomUUIDv7()}`, '5.00')),
    );

    expect(responses.map((response) => response.status)).toEqual(range(60).map(() => 201));
    expect(await debitsOf(wallet)).toBe(60);
    expect(await balanceOf(wallet)).toEqual(brl('0.00'));
    await assertLedgerMatchesBalance(db.app, wallet.id);
  });
});
