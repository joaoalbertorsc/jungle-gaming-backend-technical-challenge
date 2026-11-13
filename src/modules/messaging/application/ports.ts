import type { OutboxMessage } from '../domain/outbox-message';

export interface OutboxRepository {
  /** Appends messages to the outbox in the current transaction (§11). */
  enqueue(...messages: OutboxMessage[]): void;
}
