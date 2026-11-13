import { DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config/load-config';
import {
  ensureQueueTopology,
  type QueueNames,
  type QueueTopologyOptions,
  type QueueUrls,
} from '../../src/infrastructure/messaging/queue-topology';
import { integrationEnv, uniqueRunId } from './integration-env';

export function testSqsClient(): SQSClient {
  return new SQSClient({ endpoint: integrationEnv.sqsEndpoint, region: integrationEnv.awsRegion });
}

let defaultTopology: Promise<QueueUrls> | undefined;

/**
 * The emulator keeps queues in memory, so they vanish whenever its container restarts. Suites that
 * use the default queue names (readiness, smoke) provision them once per test process.
 */
export function ensureDefaultQueues(): Promise<QueueUrls> {
  defaultTopology ??= (async () => {
    const sqs = testSqsClient();
    try {
      return await ensureQueueTopology(sqs, loadConfig(process.env).sqs.queues);
    } finally {
      sqs.destroy();
    }
  })();
  return defaultTopology;
}

export interface IsolatedQueues {
  readonly names: QueueNames;
  readonly urls: QueueUrls;
  /** Environment overrides that point an application at these queues. */
  readonly env: Record<string, string>;
  destroy(): Promise<void>;
}

/** A private queue topology for one test file, so suites never consume each other's messages. */
export async function createIsolatedQueues(
  options: QueueTopologyOptions = {},
): Promise<IsolatedQueues> {
  const runId = uniqueRunId();
  const names: QueueNames = {
    wagerTransactions: `wt-${runId}.fifo`,
    wagerTransactionsDlq: `wt-${runId}-dlq.fifo`,
    wageringEvents: `we-${runId}.fifo`,
  };
  const sqs = testSqsClient();
  const urls = await ensureQueueTopology(sqs, names, options);
  return {
    names,
    urls,
    env: {
      WAGER_TRANSACTIONS_QUEUE: names.wagerTransactions,
      WAGER_TRANSACTIONS_DLQ: names.wagerTransactionsDlq,
      WAGERING_EVENTS_QUEUE: names.wageringEvents,
    },
    async destroy() {
      try {
        for (const url of Object.values(urls)) {
          await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
        }
      } finally {
        sqs.destroy();
      }
    },
  };
}
