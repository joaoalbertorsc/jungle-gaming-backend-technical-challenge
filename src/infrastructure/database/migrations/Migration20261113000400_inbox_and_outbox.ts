import { Migration } from '@mikro-orm/migrations';

/** Persistent inbox (ADR-0010) and transactional outbox (ADR-0011). */
const UP = [
  `CREATE TABLE inbox_messages (
     consumer_name TEXT NOT NULL,
     message_id TEXT NOT NULL,
     payload_hash TEXT NOT NULL
       CONSTRAINT inbox_messages_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
     received_at TIMESTAMPTZ NOT NULL,
     processed_at TIMESTAMPTZ,
     CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id)
   )`,

  `CREATE TABLE outbox_messages (
     id UUID PRIMARY KEY,
     aggregate_id TEXT NOT NULL,
     event_type TEXT NOT NULL,
     payload JSONB NOT NULL,
     occurred_at TIMESTAMPTZ NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0
       CONSTRAINT outbox_messages_attempts_non_negative CHECK (attempts >= 0),
     next_attempt_at TIMESTAMPTZ NOT NULL,
     published_at TIMESTAMPTZ,
     last_error TEXT
   )`,

  // Relay claims: only unpublished rows, oldest due first.
  `CREATE INDEX outbox_messages_due_idx ON outbox_messages (next_attempt_at)
     WHERE published_at IS NULL`,

  `GRANT SELECT, INSERT, UPDATE ON inbox_messages, outbox_messages TO wagering_app`,
];

const DOWN = [`DROP TABLE outbox_messages`, `DROP TABLE inbox_messages`];

export class Migration20261113000400_inbox_and_outbox extends Migration {
  override up(): void {
    for (const statement of UP) this.addSql(statement);
  }

  override down(): void {
    for (const statement of DOWN) this.addSql(statement);
  }
}
