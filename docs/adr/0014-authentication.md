# ADR-0014: Authentication deferred behind an extension point

- Status: Accepted
- Date: 2026-11-12

## Context

Authentication is worth no points (§2, §14) and must not compete with financial correctness. If it is
implemented, it must integrate an external Identity Provider; hand-rolled user tables are not acceptable. Not
implementing it is acceptable as long as the decision and the extension point are explicit. Health endpoints
stay open. Queue messages are a trusted internal channel, but the provider identity in each message is still
validated by the domain.

## Decision

**When.** Deferred to the final optional phase.

**Extension point from day one.**

- A global guard (`APP_GUARD`) behind an `AuthPort`. The default adapter is a no-op.
- Health and metrics endpoints are excluded.

**Target design** (to implement with Keycloak, under a `compose` profile `auth`):

- **Standards.** OAuth2 / OpenID Connect with JWT Bearer tokens.
- **Grant.** Providers are machines, so they use the **Client Credentials** grant, with one Keycloak client per
  provider. A mapper adds a `provider_id` claim.
- **Validation.** The guard verifies the token signature against the realm's JWKS (using the `jose` library),
  plus `iss`, `aud` and `exp`.
- **Provider identity.** A `ProviderIdentityPort` requires `body.providerId === token.provider_id`, and
  answers 403 otherwise.
- **Scopes.** For example `wagering:write`, `wallets:read`, `wallets:admin`.

| Spring Security                            | NestJS equivalent                                  |
| ------------------------------------------ | -------------------------------------------------- |
| Security filter chain                      | Guards (`CanActivate`), global through `APP_GUARD` |
| `oauth2ResourceServer().jwt()`             | `jose` (`createRemoteJWKSet` + `jwtVerify`)        |
| `@PreAuthorize("hasAuthority('SCOPE_x')")` | `@RequireScopes('x')` + `Reflector`                |
| `@AuthenticationPrincipal`                 | `@CurrentProvider()` parameter decorator           |

## Consequences

- The core phases ship without authentication, and the guard can be switched on without touching use cases.

## Alternatives considered

- **Zitadel.** Lighter, and equally valid. Keycloak is the most common IdP on the market.
- **Self-managed users and password hashing.** Disallowed by §2.
