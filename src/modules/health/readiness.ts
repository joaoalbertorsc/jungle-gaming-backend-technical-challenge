import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

export type DependencyName = 'database' | 'sqs';
export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  readonly status: 'ok' | 'unavailable';
  readonly checks: Readonly<Record<DependencyName, DependencyStatus>>;
}

const PROBE_TIMEOUT_MS = 2_000;

/** GET /health/ready: PostgreSQL and SQS reachable (§9). Probes run in parallel, each time-boxed. */
export class ReadinessChecker {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [database, sqs] = await Promise.all([
      probe(async () => {
        await this.orm.em.fork().execute('select 1');
      }),
      probe(async (signal) => {
        await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), {
          abortSignal: signal,
        });
      }),
    ]);
    return {
      status: database === 'up' && sqs === 'up' ? 'ok' : 'unavailable',
      checks: { database, sqs },
    };
  }
}

async function probe(check: (signal: AbortSignal) => Promise<void>): Promise<DependencyStatus> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    await Promise.race([
      check(signal),
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('probe timed out'));
        });
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  }
}
