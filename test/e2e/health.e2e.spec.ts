import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpApplication } from '../../src/bootstrap/create-http-application';
import { loadConfig } from '../../src/config/load-config';

describe('GET /health/live', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createHttpApplication(loadConfig(process.env));
    await app.listen(0, '127.0.0.1');
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(port)}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 200 while the process is alive', async () => {
    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('does not require authentication', async () => {
    const response = await fetch(`${baseUrl}/health/live`, { headers: {} });

    expect(response.status).toBe(200);
  });
});
