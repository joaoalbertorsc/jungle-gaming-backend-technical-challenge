import { applyDecorators, type INestApplication } from '@nestjs/common';
import {
  ApiBody,
  type ApiBodyOptions,
  ApiHeader,
  ApiResponse,
  DocumentBuilder,
  SwaggerModule,
} from '@nestjs/swagger';
import { z } from 'zod';

/**
 * OpenAPI documentation (Swagger UI at /docs). Request bodies, path and query parameters come from
 * the same Zod schemas that validate requests; responses are described by the output schemas next
 * to each controller, which the e2e suite checks against real responses so the two cannot drift.
 */

export const OPENAPI_UI_PATH = 'docs';
export const OPENAPI_JSON_PATH = 'openapi.json';
export const OPENAPI_YAML_PATH = 'openapi.yaml';

/** Money as it leaves the API: a decimal string with exactly two decimals, never a number (§5). */
export const moneyViewSchema = z
  .object({
    amount: z
      .string()
      .regex(/^-?\d+\.\d{2}$/)
      .meta({ description: 'Decimal string with exactly 2 decimals', example: '75.00' }),
    currency: z.string().meta({ description: 'ISO-4217 code', example: 'BRL' }),
  })
  .strict()
  .meta({ title: 'Money' });

/** RFC 9457 Problem Details: the body of every error, with a stable `code` (ADR-0009). */
export const problemDetailsSchema = z
  .object({
    type: z.string().meta({ example: 'urn:wagering:problem:WALLET_NOT_FOUND' }),
    title: z.string().meta({ example: 'Resource not found' }),
    status: z.number().int().meta({ example: 404 }),
    detail: z.string().meta({ example: 'wallet 0192f291-27dd-7d3f-8071-5f8685deef37 not found' }),
    code: z.string().meta({
      description: 'Stable, machine-readable error code',
      example: 'WALLET_NOT_FOUND',
    }),
    correlationId: z.string().meta({ example: '0192f2a0-3b1c-7d55-9a1e-2f6c1b7e4d10' }),
    instance: z
      .string()
      .optional()
      .meta({ example: '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37' }),
    reason: z
      .string()
      .optional()
      .meta({
        description:
          'Sub-reason: PAYLOAD_MISMATCH or EXTERNAL_ID_REUSED (409), LOCK_TIMEOUT or ' +
          'DATABASE_UNAVAILABLE (503), the rule broken by an invalid wager (400)',
      }),
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }).strict())
      .optional()
      .meta({ description: 'One entry per invalid field (VALIDATION_FAILED)' }),
  })
  .strict()
  .meta({ title: 'ProblemDetails' });

const PROBLEMS = {
  400: 'Fix the request. Codes: VALIDATION_FAILED, MALFORMED_JSON, INVALID_MONEY, INVALID_CURSOR, INVALID_WAGER_TRANSACTION, IDEMPOTENCY_KEY_REQUIRED.',
  404: 'Unknown resource. Codes: WALLET_NOT_FOUND, TRANSACTION_NOT_FOUND.',
  409: 'Conflict. Codes: IDEMPOTENCY_CONFLICT (reason PAYLOAD_MISMATCH: same key, different payload; EXTERNAL_ID_REUSED: same external id under another key), WALLET_ALREADY_EXISTS.',
  503: 'Temporarily unavailable (TEMPORARILY_UNAVAILABLE, e.g. the wallet lock timed out). Retry the same request after Retry-After; it is idempotent.',
} as const;

/** Problem Details responses for the given statuses (application/problem+json). */
export function ApiProblems(
  ...statuses: (keyof typeof PROBLEMS)[]
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: `Problem Details. ${PROBLEMS[status]}`,
        standardSchema: problemDetailsSchema,
      }),
    ),
  );
}

/**
 * Named request examples ("Try it out" presets) for a body whose schema is reflected from
 * `@Body({ schema })`. At runtime the explorer merges this explicit body into the reflected Standard
 * Schema body, keeping that schema as the single source; the library's types only model `examples`
 * next to an explicit `schema`, hence the cast. The e2e suite asserts schema and examples together.
 */
export function ApiBodyExamples(
  examples: Record<string, { summary: string; value: unknown }>,
): MethodDecorator {
  return ApiBody({ examples } as unknown as ApiBodyOptions);
}

/** The optional correlation header every endpoint accepts and echoes (ADR-0015). */
export function ApiCorrelationId(): MethodDecorator & ClassDecorator {
  return ApiHeader({
    name: 'X-Correlation-Id',
    required: false,
    description:
      'Optional. Echoed in the response, errors, logs and events; minted when absent or unsafe.',
    // No example: Swagger UI would send it on every request; leave it empty to get a fresh id.
    schema: { type: 'string' },
  });
}

const DESCRIPTION = `
Wallet and wagering API of the Distributed Wagering Processor. Every operation here is also
available asynchronously through SQS (\`wager-transactions.fifo\`), with the same rules.

**Try it in three steps**

1. \`POST /wallets\` creates a wallet. Copy the returned \`id\`.
2. \`POST /wagering/transactions\`: pick an example (BET, WIN, ...), paste the wallet \`id\` into
   \`walletId\`, and use \`{providerId}:{externalTransactionId}\` as the \`Idempotency-Key\`.
3. Send the same request again: **200** with \`idempotentReplay: true\`, and the balance does not move.

**Conventions**

- **Money** is a decimal string with up to 2 decimals on input (\`"25"\`, \`"25.5"\`, \`"25.00"\`) and
  exactly 2 on output. More decimals are rejected, never rounded.
- **Idempotency.** The same key with the same payload replays the stored outcome. The same key with a
  different payload is **409**.
- **Status codes are the contract.**
  - **201**: processed.
  - **200**: replay.
  - **202**: \`PENDING_REFERENCE\`; the reference has not arrived and the transaction is retried.
  - **422**: rejected by a business rule; see \`failureCode\`.
  - **400**, **404**, **409**: Problem Details.
  - **503**: retry later.
- **Authentication** is deferred (ADR-0014): every endpoint is open.
`;

/** Builds the document from the running application and serves Swagger UI, JSON and YAML. */
export function setupOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Distributed Wagering Processor API')
    .setDescription(DESCRIPTION)
    .setVersion('1.0.0')
    .addTag('Wallets', 'Create wallets, read balances, browse the ledger, reconcile')
    .addTag('Wagering', 'Submit BET, WIN, LOSS, REFUND and ROLLBACK; look transactions up')
    .addTag('Health', 'Liveness and readiness probes')
    .addTag('Observability', 'Prometheus metrics')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(OPENAPI_UI_PATH, app, document, {
    jsonDocumentUrl: OPENAPI_JSON_PATH,
    yamlDocumentUrl: OPENAPI_YAML_PATH,
    customSiteTitle: 'Wagering API · Swagger',
    swaggerOptions: {
      tryItOutEnabled: true,
      displayRequestDuration: true,
      docExpansion: 'list',
      defaultModelsExpandDepth: 0,
    },
  });
}
