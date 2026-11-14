import type { MikroORM } from '@mikro-orm/postgresql';
import type { OutboxStore } from '../../modules/messaging/application/outbox-relay';
import { OutboxMessage } from '../../modules/messaging/domain/outbox-message';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string;
  published_at: Date | string | null;
}

/**
 * PostgreSQL side of the relay (ADR-0011). Every statement is a single autocommit UPDATE, so no
 * lock is held while publishing; the lease in `next_attempt_at` is what prevents double claims.
 */
export class MikroOrmOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows: OutboxRow[] = await this.orm.em.fork().execute(
      `UPDATE outbox_messages AS o
          SET next_attempt_at = ?
         FROM (SELECT id FROM outbox_messages
                WHERE published_at IS NULL AND next_attempt_at <= ?
                ORDER BY next_attempt_at, occurred_at, id
                LIMIT ?
                FOR UPDATE SKIP LOCKED) AS due
        WHERE o.id = due.id
        RETURNING o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts,
                  o.next_attempt_at, o.published_at`,
      [leaseUntil, now, limit],
    );
    return rows
      .map((row) =>
        OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload:
            typeof row.payload === 'string'
              ? (JSON.parse(row.payload) as Record<string, unknown>)
              : row.payload,
          occurredAt: new Date(row.occurred_at),
          attempts: row.attempts,
          nextAttemptAt: new Date(row.next_attempt_at),
          publishedAt: row.published_at === null ? undefined : new Date(row.published_at),
        }),
      )
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.orm.em.fork().execute(
      `UPDATE outbox_messages SET published_at = ?, last_error = NULL
          WHERE id = ? AND published_at IS NULL`,
      [message.publishedAt ?? new Date(), message.id],
    );
  }

  async recordFailure(message: OutboxMessage, error: string): Promise<void> {
    await this.orm.em.fork().execute(
      `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, last_error = ?
          WHERE id = ? AND published_at IS NULL`,
      [message.attempts, message.nextAttemptAt ?? new Date(), error, message.id],
    );
  }
}
