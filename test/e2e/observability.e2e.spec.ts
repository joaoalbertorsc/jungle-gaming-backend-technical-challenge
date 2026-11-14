import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { createWorkerApplication } from '../../src/bootstrap/create-worker-application';
import { loadConfig } from '../../src/config/load-config';
import { type RunningApi, startApi } from '../support/http';
import { freePort } from '../support/processes';
import { TestDatabase } from '../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** §12: Prometheus metrics on every process and JSON logs carrying the correlation fields. */
describe('observability', () => {
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

  afterEach(() => {
    spyOn(console, 'log').mockRestore();
  });

  async function walletAndBet(correlationId = `corr-${Bun.randomUUIDv7()}`) {
    const wallet = await api.request('POST', '/wallets', {
      body: { playerId: Bun.randomUUIDv7(), initialBalance: brl('100.00') },
    });
    const externalTransactionId = `obs-${Bun.randomUUIDv7()}`;
    const bet = await api.request('POST', '/wagering/transactions', {
      headers: {
        'Idempotency-Key': `provider-a:${externalTransactionId}`,
        'X-Correlation-Id': correlationId,
      },
      body: {
        providerId: 'provider-a',
        externalTransactionId,
        playerId: wallet.body.playerId,
        walletId: wallet.body.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: brl('25.00'),
      },
    });
    expect(bet.status).toBe(201);
    return { walletId: String(wallet.body.id), transactionId: String(bet.body.transactionId) };
  }

  it('GET /metrics exposes business, latency, backlog and HTTP metrics in Prometheus format', async () => {
    await walletAndBet();

    const response = await fetch(`${api.url}/metrics`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(text).toMatch(
      /^wagering_transactions_total\{kind="BET",status="PROCESSED",channel="http"\} 1$/m,
    );
    expect(text).toMatch(
      /^wagering_processing_duration_seconds_count\{channel="http",kind="BET"\} 1$/m,
    );
    // No relay runs here: the wallet's and the bet's events are all still pending.
    expect(text).toMatch(/^wagering_outbox_pending_messages 3$/m);
    expect(text).toMatch(/^wagering_outbox_lag_seconds \d+(\.\d+)?(e[-+]?\d+)?$/m);
    expect(text).toMatch(/^wagering_pending_references 0$/m);
    expect(text).toMatch(/^wagering_dead_letter_queue_messages \d+$/m);
    expect(text).toMatch(
      /^http_request_duration_seconds_count\{method="POST",route="\/wagering\/transactions",status="201"\} 1$/m,
    );
    expect(text).toContain('process_cpu_user_seconds_total');
  });

  it('logs each request and each wager as JSON with correlation fields and no amounts', async () => {
    const lines: string[] = [];
    spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });

    const { walletId, transactionId } = await walletAndBet('corr-observability-1');

    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.find((entry) => entry.message === 'wager transaction processed')).toMatchObject({
      level: 'info',
      correlationId: 'corr-observability-1',
      transactionId,
      walletId,
      providerId: 'provider-a',
      status: 'PROCESSED',
      channel: 'http',
    });
    expect(
      entries.find(
        (entry) => entry.message === 'http request' && entry.route === '/wagering/transactions',
      ),
    ).toMatchObject({
      method: 'POST',
      route: '/wagering/transactions',
      status: 201,
      correlationId: 'corr-observability-1',
      durationMs: expect.any(Number),
    });
    expect(lines.join('\n')).not.toContain('25.00');
  });

  it('worker processes serve /metrics on METRICS_PORT and close it on shutdown', async () => {
    const port = freePort();
    const worker = await createWorkerApplication(
      loadConfig({
        ...process.env,
        APP_ROLES: 'retry-worker',
        DATABASE_URL: db.appUrl,
        METRICS_PORT: String(port),
      }),
      { logger: false },
    );

    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toMatch(/^wagering_pending_references 0$/m);
      expect((await fetch(`http://127.0.0.1:${String(port)}/elsewhere`)).status).toBe(404);
    } finally {
      await worker.close();
    }

    expect(
      await fetch(`http://127.0.0.1:${String(port)}/metrics`).then(
        () => 'open',
        () => 'closed',
      ),
    ).toBe('closed');
  });
});
