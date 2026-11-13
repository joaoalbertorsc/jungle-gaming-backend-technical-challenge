import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { expectProblem, type RunningApi, startApi } from '../support/http';
import { TestDatabase } from '../support/test-database';

/** §9 / §12: separate liveness and readiness, both unauthenticated. */
describe('HTTP: health and cross-cutting behaviour', () => {
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

  it('GET /health/live answers 200 while the process is alive', async () => {
    const response = await api.request('GET', '/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready answers 200 when PostgreSQL and SQS are reachable', async () => {
    const response = await api.request('GET', '/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', checks: { database: 'up', sqs: 'up' } });
  });

  it('GET /health/ready answers 503 and names the failing dependency', async () => {
    const broken = await startApi(db, { SQS_ENDPOINT: 'http://127.0.0.1:9' });

    try {
      const response = await broken.request('GET', '/health/ready');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        status: 'unavailable',
        checks: { database: 'up', sqs: 'down' },
      });
    } finally {
      await broken.close();
    }
  });

  it('echoes a valid X-Correlation-Id in the response header and in Problem Details', async () => {
    const response = await api.request('GET', `/wallets/${Bun.randomUUIDv7()}`, {
      headers: { 'x-correlation-id': 'corr-e2e-123' },
    });

    expect(response.headers.get('x-correlation-id')).toBe('corr-e2e-123');
    expect(response.body.correlationId).toBe('corr-e2e-123');
  });

  it('generates a correlation id when none (or an unsafe one) is sent', async () => {
    const response = await api.request('GET', '/health/live', {
      headers: { 'x-correlation-id': 'bad id with spaces' },
    });

    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers unknown routes with Problem Details too', async () => {
    expectProblem(await api.request('GET', '/nope'), 404, 'NOT_FOUND');
  });
});
