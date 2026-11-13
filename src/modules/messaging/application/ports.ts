import type { InboxMessage } from '../domain/inbox-message';
import type { OutboxMessage } from '../domain/outbox-message';

export interface OutboxRepository {
  /** Appends messages to the outbox in the current transaction (§11). */
  enqueue(...messages: OutboxMessage[]): void;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  /**
   * Records a consumed message in the current transaction (ADR-0010). A concurrent copy of the same
   * message makes the commit fail with a unique violation on `inbox_messages_pkey`.
   */
  record(message: InboxMessage): void;
}
