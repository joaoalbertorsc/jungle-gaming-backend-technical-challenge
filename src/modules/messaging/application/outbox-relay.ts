import type {
  ApplicationLogger,
  ApplicationMetrics,
  Clock,
  FaultInjector,
} from '../../../shared/application/ports';
import type { ExponentialBackoff } from '../../../shared/domain/exponential-backoff';
import type { OutboxMessage } from '../domain/outbox-message';

/** Outbox access for the relay: short, independent statements (no long-held locks). */
export interface OutboxStore {
  /**
   * Atomically claims up to `limit` due, unpublished messages for this relay by pushing their
   * `next_attempt_at` to `now + leaseMs` (FOR UPDATE SKIP LOCKED). If the relay dies, the lease
   * expires and another instance claims them (ADR-0011).
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(message: OutboxMessage): Promise<void>;
  recordFailure(message: OutboxMessage, error: string): Promise<void>;
}

export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export interface OutboxRelaySettings {
  readonly store: OutboxStore;
  readonly publisher: EventPublisher;
  readonly clock: Clock;
  readonly metrics: ApplicationMetrics;
  readonly logger: ApplicationLogger;
  readonly faults?: FaultInjector | undefined;
  readonly batchSize: number;
  readonly leaseMs: number;
  /** Pause between polls when the outbox is empty. */
  readonly pollIntervalMs: number;
  readonly retryBackoff: ExponentialBackoff;
}

export interface PublishRound {
  readonly published: readonly string[];
  readonly failed: readonly string[];
}

/**
 * Publishes committed outbox messages (§11, ADR-0011). Delivery is at least once: a message is
 * marked published only after the broker accepted it, so a crash in between causes a republish
 * that consumers absorb by deduplicating on eventId. Any number of relays can run concurrently.
 */
export class OutboxRelay {
  private stopping = false;
  private loop: Promise<void> | undefined;

  constructor(private readonly settings: OutboxRelaySettings) {}

  async publishOnce(): Promise<PublishRound> {
    const { store, publisher, clock, batchSize, leaseMs } = this.settings;
    const claimed = await store.claimDue(clock.now(), batchSize, leaseMs);
    const published: string[] = [];
    const failed: string[] = [];

    // Sequential, in occurred_at order, so one relay keeps the per-aggregate order of its batch.
    for (const message of claimed) {
      this.settings.faults?.hit('outbox.before-publish');
      try {
        await publisher.publish(message);
      } catch (error) {
        await this.fail(message, error);
        failed.push(message.id);
        continue;
      }
      // A crash here leaves the message leased but unmarked: it is republished after the lease.
      this.settings.faults?.hit('outbox.after-publish');
      message.markPublished(clock.now());
      await store.markPublished(message);
      this.settings.metrics.outboxPublished(message.eventType);
      published.push(message.id);
    }
    return { published, failed };
  }

  start(): void {
    if (this.loop !== undefined) return;
    this.stopping = false;
    this.loop = this.run();
  }

  /** Finishes the current round; claimed but unpublished messages are retried after their lease. */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (!this.isStopping()) {
      try {
        const round = await this.publishOnce();
        if (round.published.length === 0 && round.failed.length === 0) {
          await Bun.sleep(this.settings.pollIntervalMs);
        }
      } catch (error) {
        this.settings.logger.error('outbox relay round failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        await Bun.sleep(this.settings.pollIntervalMs);
      }
    }
  }

  /** Read through a method: `stopping` changes while this instance awaits, which narrowing ignores. */
  private isStopping(): boolean {
    return this.stopping;
  }

  private async fail(message: OutboxMessage, error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    message.scheduleRetry(this.settings.clock.now(), this.settings.retryBackoff);
    await this.settings.store.recordFailure(message, detail.slice(0, 1_000));
    this.settings.metrics.outboxFailed();
    this.settings.logger.warn('outbox publication failed; will retry', {
      eventId: message.id,
      eventType: message.eventType,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt?.toISOString(),
    });
  }
}
