import { expect } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpApplication } from '../../src/bootstrap/create-http-application';
import { loadConfig } from '../../src/config/load-config';
import { ensureDefaultQueues } from './queues';
import type { TestDatabase } from './test-database';

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export interface RunningApi {
  readonly app: INestApplication;
  request(
    method: 'GET' | 'POST',
    path: string,
    options?: { body?: unknown; headers?: Record<string, string>; rawBody?: string },
  ): Promise<HttpResponse>;
  close(): Promise<void>;
}

/** Starts the real HTTP application (same wiring as main.ts) against a test database. */
export async function startApi(
  db: TestDatabase,
  env: Record<string, string> = {},
): Promise<RunningApi> {
  await ensureDefaultQueues();
  const config = loadConfig({ ...process.env, DATABASE_URL: db.appUrl, ...env });
  const app = await createHttpApplication(config, { logger: false });
  await app.listen(0, '127.0.0.1');
  const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  return {
    app,
    async request(method, path, options = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...options.headers },
        body:
          options.rawBody ??
          (options.body === undefined ? undefined : JSON.stringify(options.body)),
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
      };
    },
    close: () => app.close(),
  };
}

/** Every error, on every endpoint, is RFC 9457 Problem Details with a stable code (ADR-0009). */
export function expectProblem(response: HttpResponse, status: number, code: string): void {
  expect({ status: response.status, code: response.body.code }).toEqual({ status, code });
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.body).toMatchObject({
    type: expect.stringContaining(code) as unknown,
    title: expect.any(String) as unknown,
    status,
    correlationId: expect.any(String) as unknown,
  });
}
