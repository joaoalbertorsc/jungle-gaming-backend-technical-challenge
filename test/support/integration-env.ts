/**
 * Integration tests run against real PostgreSQL and SQS containers.
 * A missing variable is a hard failure: these suites must never silently skip.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable "${name}". ` +
        'Run integration tests through `docker compose run --rm workspace ...`.',
    );
  }
  return value;
}

export const integrationEnv = {
  get migrationDatabaseUrl(): string {
    return requireEnv('MIGRATION_DATABASE_URL');
  },
  get databaseUrl(): string {
    return requireEnv('DATABASE_URL');
  },
  get sqsEndpoint(): string {
    return requireEnv('SQS_ENDPOINT');
  },
  get awsRegion(): string {
    return requireEnv('AWS_REGION');
  },
};

/** Unique suffix so concurrent or repeated runs never share queues or tables. */
export function uniqueRunId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
