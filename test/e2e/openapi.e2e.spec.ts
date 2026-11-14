import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import {
  ledgerPageSchema,
  reconciliationReportSchema,
  walletViewSchema,
} from '../../src/modules/wallet/interface/http/wallet.openapi';
import {
  wagerOutcomeSchema,
  wagerTransactionViewSchema,
} from '../../src/modules/wagering/interface/http/wager.openapi';
import {
  livenessSchema,
  readinessSchema,
} from '../../src/modules/health/interface/http/health.openapi';
import { problemDetailsSchema } from '../../src/shared/interface/http/openapi';
import { type HttpResponse, type RunningApi, startApi } from '../support/http';
import { TestDatabase } from '../support/test-database';

interface Operation {
  tags?: string[];
  summary?: string;
  parameters?: { name: string; in: string; required?: boolean; schema?: Record<string, unknown> }[];
  requestBody?: {
    content: Record<string, { schema?: unknown; examples?: Record<string, unknown> }>;
  };
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** Every endpoint, as the OpenAPI document must list it. */
const OPERATIONS = [
  'post /wallets',
  'get /wallets/{walletId}',
  'get /wallets/{walletId}/ledger',
  'post /wallets/{walletId}/reconciliation',
  'post /wagering/transactions',
  'get /wagering/transactions/{transactionId}',
  'get /providers/{providerId}/wagering/transactions/{externalTransactionId}',
  'get /health/live',
  'get /health/ready',
  'get /metrics',
];

/** Interactive API documentation (Swagger UI) generated from the same schemas that validate requests. */
describe('OpenAPI documentation', () => {
  let db: TestDatabase;
  let api: RunningApi;
  let doc: OpenApiDocument;

  beforeAll(async () => {
    db = await TestDatabase.create();
    api = await startApi(db);
    doc = (await (await fetch(`${api.url}/openapi.json`)).json()) as OpenApiDocument;
  });

  afterAll(async () => {
    await api.close();
    await db.drop();
  });

  const operation = (method: string, path: string): Operation => {
    const found = doc.paths[path]?.[method];
    if (found === undefined) throw new Error(`${method} ${path} is not documented`);
    return found;
  };

  describe('the document', () => {
    it('serves Swagger UI at /docs and the document as JSON and YAML', async () => {
      const ui = await fetch(`${api.url}/docs`);
      expect(ui.status).toBe(200);
      expect(await ui.text()).toContain('swagger-ui');
      expect(doc.openapi).toStartWith('3.');
      expect(doc.info.title).toBe('Distributed Wagering Processor API');
      const yaml = await fetch(`${api.url}/openapi.yaml`);
      expect(yaml.status).toBe(200);
      expect(await yaml.text()).toContain('/wagering/transactions');
    });

    it('lists exactly the endpoints the API serves, each with a tag and a summary', () => {
      const documented = Object.entries(doc.paths).flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method} ${path}`),
      );

      expect(documented.sort()).toEqual([...OPERATIONS].sort());
      for (const entry of OPERATIONS) {
        const [method = '', path = ''] = entry.split(' ');
        const op = operation(method, path);
        expect(op.tags?.length).toBeGreaterThan(0);
        expect(op.summary?.length).toBeGreaterThan(0);
      }
    });

    it('documents the wager submission: body from the validation schema, headers and examples', () => {
      const submit = operation('post', '/wagering/transactions');
      const body = submit.requestBody?.content['application/json'];

      expect(JSON.stringify(body?.schema)).toContain(
        '"enum":["BET","WIN","LOSS","REFUND","ROLLBACK"]',
      );
      expect(Object.keys(body?.examples ?? {}).sort()).toEqual(
        ['bet', 'loss', 'refund', 'rollback', 'win'].sort(),
      );
      expect(submit.parameters).toContainEqual(
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      );
      expect(submit.parameters).toContainEqual(
        expect.objectContaining({ name: 'X-Correlation-Id', in: 'header', required: false }),
      );
    });

    it('documents path and query parameters with their constraints', () => {
      const ledger = operation('get', '/wallets/{walletId}/ledger');
      const names = (ledger.parameters ?? []).map((p) => `${p.in}:${p.name}`);

      expect(names).toEqual(
        expect.arrayContaining(['path:walletId', 'query:cursor', 'query:limit']),
      );
      expect(ledger.parameters?.find((p) => p.name === 'walletId')?.schema).toMatchObject({
        format: 'uuid',
      });
    });

    it.each([
      ['post', '/wallets', ['201', '400', '409']],
      ['get', '/wallets/{walletId}', ['200', '400', '404']],
      ['get', '/wallets/{walletId}/ledger', ['200', '400', '404']],
      ['post', '/wallets/{walletId}/reconciliation', ['200', '400', '404']],
      ['post', '/wagering/transactions', ['200', '201', '202', '400', '409', '422', '503']],
      ['get', '/wagering/transactions/{transactionId}', ['200', '400', '404']],
      [
        'get',
        '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
        ['200', '400', '404'],
      ],
      ['get', '/health/live', ['200']],
      ['get', '/health/ready', ['200', '503']],
      ['get', '/metrics', ['200']],
    ])('documents every status of %s %s', (method, path, statuses) => {
      const responses = operation(method, path).responses;

      expect(Object.keys(responses).sort()).toEqual([...statuses].sort());
      for (const status of statuses) {
        expect(responses[status]?.content).toBeDefined();
      }
    });
  });

  /** Drift guard: real responses must match the schemas the document advertises. */
  describe('real responses match the documented schemas', () => {
    function conforms<T extends z.ZodType>(response: HttpResponse, status: number, schema: T) {
      expect(response.status).toBe(status);
      const parsed = schema.safeParse(response.body);
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    }

    async function submit(body: Record<string, unknown>) {
      return api.request('POST', '/wagering/transactions', {
        headers: { 'Idempotency-Key': `provider-a:${String(body.externalTransactionId)}` },
        body,
      });
    }

    it('wallets, ledger and reconciliation', async () => {
      const created = await api.request('POST', '/wallets', {
        body: { playerId: 'player-docs', initialBalance: brl('100.00') },
      });
      conforms(created, 201, walletViewSchema);
      const id = String(created.body.id);

      conforms(await api.request('GET', `/wallets/${id}`), 200, walletViewSchema);
      conforms(await api.request('GET', `/wallets/${id}/ledger?limit=1`), 200, ledgerPageSchema);
      conforms(
        await api.request('POST', `/wallets/${id}/reconciliation`),
        200,
        reconciliationReportSchema,
      );
      conforms(
        await api.request('POST', '/wallets', {
          body: { playerId: 'player-docs', initialBalance: brl('1.00') },
        }),
        409,
        problemDetailsSchema,
      );
      conforms(
        await api.request('GET', `/wallets/${Bun.randomUUIDv7()}`),
        404,
        problemDetailsSchema,
      );
      conforms(await api.request('GET', '/wallets/not-a-uuid'), 400, problemDetailsSchema);
    });

    it('wager outcomes: 201, 200 replay, 202 pending, 422 rejected, 400 and 409 problems', async () => {
      const wallet = await api.request('POST', '/wallets', {
        body: { playerId: 'player-wagers', initialBalance: brl('50.00') },
      });
      const base = {
        providerId: 'provider-a',
        playerId: 'player-wagers',
        walletId: String(wallet.body.id),
        roundId: 'round-1',
        gameId: 'game-1',
      };
      const bet = {
        ...base,
        externalTransactionId: `docs-${Bun.randomUUIDv7()}`,
        kind: 'BET',
        money: brl('10.00'),
      };

      const processed = await submit(bet);
      conforms(processed, 201, wagerOutcomeSchema);
      conforms(await submit(bet), 200, wagerOutcomeSchema);
      conforms(
        await submit({
          ...base,
          externalTransactionId: `docs-${Bun.randomUUIDv7()}`,
          kind: 'REFUND',
          referenceExternalTransactionId: 'not-yet-arrived',
          money: brl('10.00'),
        }),
        202,
        wagerOutcomeSchema,
      );
      conforms(
        await submit({
          ...base,
          externalTransactionId: `docs-${Bun.randomUUIDv7()}`,
          kind: 'BET',
          money: brl('999.00'),
        }),
        422,
        wagerOutcomeSchema,
      );
      conforms(await submit({ ...bet, money: brl('11.00') }), 409, problemDetailsSchema);
      conforms(await submit({ ...base, kind: 'BET' }), 400, problemDetailsSchema);

      const transactionId = String(processed.body.transactionId);
      conforms(
        await api.request('GET', `/wagering/transactions/${transactionId}`),
        200,
        wagerTransactionViewSchema,
      );
      conforms(
        await api.request(
          'GET',
          `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`,
        ),
        200,
        wagerTransactionViewSchema,
      );
    });

    it('health probes', async () => {
      conforms(await api.request('GET', '/health/live'), 200, livenessSchema);
      conforms(await api.request('GET', '/health/ready'), 200, readinessSchema);
    });
  });
});
