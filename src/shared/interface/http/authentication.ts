import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';

export interface AuthenticationRequest {
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

/**
 * The authentication extension point (ADR-0014). A Keycloak adapter would verify the Bearer JWT here
 * (JWKS signature, iss, aud, exp) and attach the provider identity.
 */
export interface AuthPort {
  authenticate(request: AuthenticationRequest): boolean | Promise<boolean>;
}

export const AUTH_PORT = Symbol('AUTH_PORT');

/** Default adapter while authentication is deferred: every request is let through. */
export class AllowAllAuthentication implements AuthPort {
  authenticate(): boolean {
    return true;
  }
}

/** Probes, scrapes and the API documentation stay unauthenticated. */
const PUBLIC_PATHS = /^\/(health\/|metrics$|docs(\/|$)|openapi\.(json|yaml)$)/;

/** Global guard (APP_GUARD), the NestJS counterpart of a Spring Security filter chain. */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(@Inject(AUTH_PORT) private readonly auth: AuthPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<AuthenticationRequest>();
    if (PUBLIC_PATHS.test(request.path)) return true;
    return this.auth.authenticate(request);
  }
}
