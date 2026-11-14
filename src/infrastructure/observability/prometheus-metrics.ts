import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { ApplicationMetrics } from '../../shared/application/ports';

/** Work waiting in the system, read when metrics are scraped. */
export interface Backlog {
  readonly outboxPending: number;
  /** Age of the oldest unpublished event; undefined when the outbox is empty. */
  readonly outboxOldestAgeSeconds: number | undefined;
  readonly pendingReferences: number;
  /** Messages in the dead-letter queue; undefined when the broker could not be asked. */
  readonly deadLetterMessages: number | undefined;
}

export interface BacklogProbe {
  read(): Promise<Backlog>;
}

export interface PrometheusMetricsOptions {
  readonly backlog: BacklogProbe;
  /** Process metrics (CPU, memory, event loop); on by default. */
  readonly defaultMetrics?: boolean;
}

/**
 * The Prometheus adapter for ApplicationMetrics (§12). Each process owns its registry; the API
 * serves it on GET /metrics and worker processes on METRICS_PORT.
 */
export class PrometheusMetrics implements ApplicationMetrics {
  readonly registry = new Registry();
  readonly contentType = Registry.PROMETHEUS_CONTENT_TYPE;

  private readonly transactions = this.counter(
    'wagering_transactions_total',
    'Wager transactions decided, by kind, status and channel.',
    ['kind', 'status', 'channel'],
  );
  private readonly replays = this.counter(
    'wagering_idempotent_replays_total',
    'Requests answered from a stored outcome (idempotent replay).',
    ['channel'],
  );
  private readonly duplicates = this.counter(
    'wagering_duplicate_messages_total',
    'Queue messages already recorded in the inbox.',
    ['consumer'],
  );
  private readonly retries = this.counter(
    'wagering_message_retries_total',
    'Queue messages left for redelivery after a transient failure.',
    ['reason'],
  );
  private readonly deadLetters = this.counter(
    'wagering_dead_lettered_messages_total',
    'Queue messages moved to the dead-letter queue.',
    ['reason'],
  );
  private readonly lockConflicts = this.counter(
    'wagering_lock_conflicts_total',
    'Wallet lock waits that hit the lock timeout.',
  );
  private readonly reconciliationMismatches = this.counter(
    'wagering_reconciliation_mismatches_total',
    'Wallets whose balance disagreed with their ledger.',
  );
  private readonly published = this.counter(
    'wagering_outbox_published_total',
    'Outbox events published to the broker.',
    ['event_type'],
  );
  private readonly outboxFailures = this.counter(
    'wagering_outbox_publish_failures_total',
    'Outbox publication attempts that failed and were rescheduled.',
  );
  private readonly referenceRetries = this.counter(
    'wagering_reference_retries_total',
    'PENDING_REFERENCE retry attempts, by result.',
    ['result'],
  );
  private readonly probeFailures = this.counter(
    'wagering_metrics_probe_failures_total',
    'Scrapes during which the backlog could not be read.',
  );
  private readonly processing = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Time to process one wager submission, by channel and kind.',
    labelNames: ['channel', 'kind'],
    registers: [this.registry],
  });
  private readonly http = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration, by method, route and status.',
    labelNames: ['method', 'route', 'status'],
    registers: [this.registry],
  });
  private readonly outboxLag = this.gauge(
    'wagering_outbox_lag_seconds',
    'Age of the oldest unpublished outbox event (0 when the outbox is empty).',
  );
  private readonly outboxPending = this.gauge(
    'wagering_outbox_pending_messages',
    'Outbox events not yet published.',
  );
  private readonly pendingReferences = this.gauge(
    'wagering_pending_references',
    'Transactions waiting for their reference (PENDING_REFERENCE).',
  );
  private readonly deadLetterDepth = this.gauge(
    'wagering_dead_letter_queue_messages',
    'Messages currently in the dead-letter queue (NaN when unknown).',
  );

  constructor(private readonly options: PrometheusMetricsOptions) {
    if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry });
  }

  /** The exposition text, with the backlog gauges refreshed first. */
  async render(): Promise<string> {
    await this.refreshBacklog();
    return this.registry.metrics();
  }

  transactionOutcome(kind: string, status: string, channel: string): void {
    this.transactions.inc({ kind, status, channel });
  }
  idempotentReplay(channel: string): void {
    this.replays.inc({ channel });
  }
  lockConflict(): void {
    this.lockConflicts.inc();
  }
  reconciliationMismatch(): void {
    this.reconciliationMismatches.inc();
  }
  duplicateMessage(consumer: string): void {
    this.duplicates.inc({ consumer });
  }
  messageRetried(reason: string): void {
    this.retries.inc({ reason });
  }
  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }
  outboxPublished(eventType: string): void {
    this.published.inc({ event_type: eventType });
  }
  outboxFailed(): void {
    this.outboxFailures.inc();
  }
  referenceRetry(result: string): void {
    this.referenceRetries.inc({ result });
  }
  processingDuration(channel: string, kind: string, seconds: number): void {
    this.processing.observe({ channel, kind }, seconds);
  }
  httpRequest(method: string, route: string, status: number, seconds: number): void {
    this.http.observe({ method, route, status: String(status) }, seconds);
  }

  private async refreshBacklog(): Promise<void> {
    try {
      const backlog = await this.options.backlog.read();
      this.outboxPending.set(backlog.outboxPending);
      this.outboxLag.set(backlog.outboxOldestAgeSeconds ?? 0);
      this.pendingReferences.set(backlog.pendingReferences);
      this.deadLetterDepth.set(backlog.deadLetterMessages ?? Number.NaN);
    } catch {
      // Stale numbers would mislead: report them as unknown and count the failure.
      for (const gauge of [this.outboxPending, this.outboxLag, this.pendingReferences]) {
        gauge.set(Number.NaN);
      }
      this.deadLetterDepth.set(Number.NaN);
      this.probeFailures.inc();
    }
  }

  private counter<L extends string>(name: string, help: string, labelNames: L[] = []): Counter<L> {
    return new Counter({ name, help, labelNames, registers: [this.registry] });
  }

  private gauge(name: string, help: string): Gauge {
    return new Gauge({ name, help, registers: [this.registry] });
  }
}
