import { describe, expect, it } from 'bun:test';
import {
  type Backlog,
  PrometheusMetrics,
} from '../../../../src/infrastructure/observability/prometheus-metrics';

const backlog = (overrides: Partial<Backlog> = {}) => ({
  read: () =>
    Promise.resolve({
      outboxPending: 2,
      outboxOldestAgeSeconds: 12.5,
      pendingReferences: 1,
      deadLetterMessages: 3,
      ...overrides,
    }),
});

const metricsWith = (probe = backlog()) =>
  new PrometheusMetrics({ backlog: probe, defaultMetrics: false });

/** §12: the metrics every process exposes in the Prometheus text format. */
describe('PrometheusMetrics', () => {
  it('counts transactions by kind, status and channel', async () => {
    const metrics = metricsWith();
    metrics.transactionOutcome('BET', 'PROCESSED', 'http');
    metrics.transactionOutcome('BET', 'PROCESSED', 'http');
    metrics.transactionOutcome('BET', 'REJECTED', 'sqs');

    const text = await metrics.render();

    expect(text).toContain(
      'wagering_transactions_total{kind="BET",status="PROCESSED",channel="http"} 2',
    );
    expect(text).toContain(
      'wagering_transactions_total{kind="BET",status="REJECTED",channel="sqs"} 1',
    );
  });

  it('counts replays, duplicates, retries, dead letters, lock conflicts and the workers', async () => {
    const metrics = metricsWith();
    metrics.idempotentReplay('http');
    metrics.duplicateMessage('wager-transactions');
    metrics.messageRetried('LOCK_TIMEOUT');
    metrics.deadLettered('INVALID_MESSAGE');
    metrics.lockConflict();
    metrics.reconciliationMismatch();
    metrics.outboxPublished('WalletBalanceChanged');
    metrics.outboxFailed();
    metrics.referenceRetry('rescheduled');

    const text = await metrics.render();

    for (const line of [
      'wagering_idempotent_replays_total{channel="http"} 1',
      'wagering_duplicate_messages_total{consumer="wager-transactions"} 1',
      'wagering_message_retries_total{reason="LOCK_TIMEOUT"} 1',
      'wagering_dead_lettered_messages_total{reason="INVALID_MESSAGE"} 1',
      'wagering_lock_conflicts_total 1',
      'wagering_reconciliation_mismatches_total 1',
      'wagering_outbox_published_total{event_type="WalletBalanceChanged"} 1',
      'wagering_outbox_publish_failures_total 1',
      'wagering_reference_retries_total{result="rescheduled"} 1',
    ]) {
      expect(text).toContain(line);
    }
  });

  it('records processing latency as a histogram per channel and kind', async () => {
    const metrics = metricsWith();
    metrics.processingDuration('sqs', 'BET', 0.004);

    const text = await metrics.render();

    expect(text).toContain(
      'wagering_processing_duration_seconds_count{channel="sqs",kind="BET"} 1',
    );
    expect(text).toContain(
      'wagering_processing_duration_seconds_bucket{le="0.005",channel="sqs",kind="BET"} 1',
    );
  });

  it('records HTTP request durations by method, route and status', async () => {
    const metrics = metricsWith();
    metrics.httpRequest('POST', '/wagering/transactions', 201, 0.02);

    expect(await metrics.render()).toContain(
      'http_request_duration_seconds_count{method="POST",route="/wagering/transactions",status="201"} 1',
    );
  });

  it('reads outbox lag, pending references and DLQ depth when scraped', async () => {
    const text = await metricsWith().render();

    expect(text).toContain('wagering_outbox_lag_seconds 12.5');
    expect(text).toContain('wagering_outbox_pending_messages 2');
    expect(text).toContain('wagering_pending_references 1');
    expect(text).toContain('wagering_dead_letter_queue_messages 3');
  });

  it('reports an empty outbox as zero lag and skips an unknown DLQ depth', async () => {
    const text = await metricsWith(
      backlog({
        outboxPending: 0,
        outboxOldestAgeSeconds: undefined,
        deadLetterMessages: undefined,
      }),
    ).render();

    expect(text).toContain('wagering_outbox_lag_seconds 0');
    expect(text).not.toMatch(/^wagering_dead_letter_queue_messages \d/m);
  });

  it('keeps serving every other metric when the backlog cannot be read', async () => {
    const metrics = metricsWith({ read: () => Promise.reject(new Error('database down')) });
    metrics.lockConflict();

    const text = await metrics.render();

    expect(text).toContain('wagering_lock_conflicts_total 1');
    expect(text).toContain('wagering_metrics_probe_failures_total 1');
  });

  it('serves the Prometheus text content type', () => {
    expect(metricsWith().contentType).toContain('text/plain');
  });
});
