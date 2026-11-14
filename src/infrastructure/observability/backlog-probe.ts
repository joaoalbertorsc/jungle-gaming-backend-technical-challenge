import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Backlog, BacklogProbe } from './prometheus-metrics';

interface OutboxRow {
  pending: number;
  oldest_age_seconds: number | string | null;
}

/** Reads the backlog gauges from PostgreSQL (outbox, pending references) and SQS (DLQ depth). */
export class DatabaseAndQueueBacklog implements BacklogProbe {
  private deadLetterQueueUrl: string | undefined;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly deadLetterQueueName: string,
  ) {}

  async read(): Promise<Backlog> {
    const em = this.orm.em.fork();
    const [[outbox], [references], deadLetterMessages] = await Promise.all([
      em.execute<OutboxRow[]>(
        `SELECT count(*)::int AS pending,
                EXTRACT(EPOCH FROM (now() - min(occurred_at)))::float8 AS oldest_age_seconds
           FROM outbox_messages WHERE published_at IS NULL`,
      ),
      em.execute<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
      ),
      this.deadLetterDepth(),
    ]);
    const age = outbox?.oldest_age_seconds;
    return {
      outboxPending: outbox?.pending ?? 0,
      outboxOldestAgeSeconds:
        age === null || age === undefined ? undefined : Math.max(0, Number(age)),
      pendingReferences: references?.n ?? 0,
      deadLetterMessages,
    };
  }

  /** Undefined when the broker cannot answer: the metric shows NaN instead of a guess. */
  private async deadLetterDepth(): Promise<number | undefined> {
    try {
      this.deadLetterQueueUrl ??= (
        await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.deadLetterQueueName }))
      ).QueueUrl;
      const { Attributes } = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.deadLetterQueueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
      const depth = Number(Attributes?.ApproximateNumberOfMessages);
      return Number.isFinite(depth) ? depth : undefined;
    } catch {
      this.deadLetterQueueUrl = undefined;
      return undefined;
    }
  }
}
