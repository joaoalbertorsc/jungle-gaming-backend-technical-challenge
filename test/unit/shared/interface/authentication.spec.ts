import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import {
  AllowAllAuthentication,
  type AuthPort,
  AuthenticationGuard,
} from '../../../../src/shared/interface/http/authentication';

const http = (path: string) =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ path, headers: {} }) }),
  }) as unknown as ExecutionContext;

const denyAll: AuthPort = { authenticate: () => false };

/** ADR-0014: the authentication extension point that a Keycloak adapter plugs into. */
describe('AuthenticationGuard', () => {
  it('asks the auth port about every business endpoint', async () => {
    expect(await new AuthenticationGuard(denyAll).canActivate(http('/wallets'))).toBe(false);
    expect(await new AuthenticationGuard(denyAll).canActivate(http('/wagering/transactions'))).toBe(
      false,
    );
  });

  it.each([
    '/health/live',
    '/health/ready',
    '/metrics',
    '/docs',
    '/docs/swagger-ui.css',
    '/openapi.json',
    '/openapi.yaml',
  ])('leaves %s open', async (path) => {
    expect(await new AuthenticationGuard(denyAll).canActivate(http(path))).toBe(true);
  });

  it('lets every request through by default (authentication is deferred)', async () => {
    const guard = new AuthenticationGuard(new AllowAllAuthentication());
    expect(await guard.canActivate(http('/wallets'))).toBe(true);
  });

  it('does not apply to non-HTTP contexts', async () => {
    const context = { getType: () => 'rpc' } as unknown as ExecutionContext;
    expect(await new AuthenticationGuard(denyAll).canActivate(context)).toBe(true);
  });
});
