import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';

export interface QueueNames {
  /** Inbound wager requests; redrives to the DLQ after `maxReceiveCount` receives. */
  readonly wagerTransactions: string;
  /** Permanent failures and exhausted retries. */
  readonly wagerTransactionsDlq: string;
  /** Integration events published by the outbox relay. */
  readonly wageringEvents: string;
}

export interface QueueTopologyOptions {
  readonly maxReceiveCount?: number;
  readonly visibilityTimeoutSeconds?: number;
}

export interface QueueUrls {
  readonly wagerTransactions: string;
  readonly wagerTransactionsDlq: string;
  readonly wageringEvents: string;
}

export const DEFAULT_MAX_RECEIVE_COUNT = 5;
export const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 30;

/**
 * Creates the FIFO queues and the redrive policy (ADR-0010). CreateQueue is idempotent for
 * identical attributes, so this runs safely at every start (`sqs-init`) and in test setup.
 */
export async function ensureQueueTopology(
  sqs: SQSClient,
  names: QueueNames,
  options: QueueTopologyOptions = {},
): Promise<QueueUrls> {
  const visibility = String(options.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS);
  const createFifo = async (name: string, attributes: Record<string, string> = {}) => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: { FifoQueue: 'true', VisibilityTimeout: visibility, ...attributes },
      }),
    );
    if (QueueUrl === undefined) throw new Error(`CreateQueue returned no URL for ${name}`);
    return QueueUrl;
  };

  const wagerTransactionsDlq = await createFifo(names.wagerTransactionsDlq);
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: wagerTransactionsDlq, AttributeNames: ['QueueArn'] }),
  );
  if (Attributes?.QueueArn === undefined) throw new Error('the DLQ has no ARN');

  const wagerTransactions = await createFifo(names.wagerTransactions, {
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: Attributes.QueueArn,
      maxReceiveCount: options.maxReceiveCount ?? DEFAULT_MAX_RECEIVE_COUNT,
    }),
  });
  const wageringEvents = await createFifo(names.wageringEvents);

  return { wagerTransactions, wagerTransactionsDlq, wageringEvents };
}
