import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { UniqueViolationError } from '../../../../shared/application/application-errors';
import type {
  ApplicationLogger,
  ApplicationMetrics,
  Clock,
  FaultInjector,
  RequestContext,
} from '../../../../shared/application/ports';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work';
import type { ExponentialBackoff } from '../../../../shared/domain/exponential-backoff';
import { InboxMessage } from '../../../messaging/domain/inbox-message';
import type { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { classifyFailure } from './failure-classifier';
import { parseWagerMessage, type WagerMessage } from './wager-message';

export interface WagerTransactionConsumerSettings {
  readonly sqs: SQSClient;
  readonly queueUrl: string;
  readonly deadLetterQueueUrl: string;
  readonly consumerName: string;
  readonly submit: SubmitWagerTransaction;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly metrics: ApplicationMetrics;
  readonly logger: ApplicationLogger;
  readonly faults?: FaultInjector | undefined;
  /** SQS long-poll duration (0–20 s). */
  readonly waitTimeSeconds: number;
  readonly maxMessages: number;
  /** How long stop() waits for in-flight messages before giving up. */
  readonly drainTimeoutMs: number;
  /** Delay before a transiently failed message becomes visible again. */
  readonly retryBackoff: ExponentialBackoff;
}

const MAX_ATTRIBUTE_LENGTH = 256;

/**
 * Long-polling consumer of `wager-transactions.fifo` (§10, ADR-0010).
 *
 * - Reuses SubmitWagerTransaction, the same use case as HTTP.
 * - Deduplicates through the persistent inbox `(consumerName, messageId)`, written in the same SQL
 *   transaction as the effects.
 * - Deletes (acks) a message only after that transaction committed.
 * - Business outcomes are acked; transient failures return the message after a backoff (the redrive
 *   policy caps attempts); permanent failures are sent to the DLQ with a reason, then deleted.
 * - stop() stops polling, finishes messages in flight and releases those not started yet.
 */
export class WagerTransactionConsumer {
  private stopping = false;
  private polling: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(private readonly settings: WagerTransactionConsumerSettings) {}

  start(): void {
    if (this.loop !== undefined) return;
    this.stopping = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.polling?.abort();
    if (this.loop === undefined) return;

    const drained = await Promise.race([
      this.loop.then(() => true),
      Bun.sleep(this.settings.drainTimeoutMs).then(() => false),
    ]);
    if (!drained) {
      this.settings.logger.warn('consumer stopped before in-flight messages finished', {
        consumer: this.settings.consumerName,
      });
    }
    this.loop = undefined;
  }

  /** Receives one batch and processes it. Returns how many messages were received. */
  async pollOnce(): Promise<number> {
    const { sqs, queueUrl, maxMessages, waitTimeSeconds } = this.settings;
    this.polling = new AbortController();
    const { Messages: messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: this.polling.signal },
    );

    // FIFO semantics: messages of one group in order, different groups in parallel.
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.isStopping()) await this.release(message);
          else await this.handle(message);
        }
      }),
    );
    return messages.length;
  }

  private async run(): Promise<void> {
    while (!this.isStopping()) {
      try {
        await this.pollOnce();
      } catch (error) {
        // stop() aborts the long poll, which surfaces here as an error.
        if (this.isStopping()) break;
        this.settings.logger.error('consumer poll failed', {
          consumer: this.settings.consumerName,
          error: error instanceof Error ? error.message : String(error),
        });
        await Bun.sleep(1_000);
      }
    }
  }

  /** Read through a method: `stopping` changes while this instance awaits, which narrowing ignores. */
  private isStopping(): boolean {
    return this.stopping;
  }

  private async handle(message: Message): Promise<void> {
    const parsed = parseWagerMessage(message.Body ?? '');
    if (!parsed.ok) {
      await this.deadLetter(message, parsed.reason, parsed.detail);
      return;
    }
    const { message: wager, payloadHash } = parsed;
    // The correlation fields of every log line about this message (§12); never the amount.
    const fields = {
      consumer: this.settings.consumerName,
      correlationId: wager.messageId,
      messageId: wager.messageId,
      walletId: wager.data.walletId,
      providerId: wager.data.providerId,
    };

    try {
      const seen = await this.settings.unitOfWork.read(({ inbox }) =>
        inbox.find(this.settings.consumerName, wager.messageId),
      );
      if (seen !== undefined) {
        if (!seen.matchesPayload(payloadHash)) {
          await this.deadLetter(message, 'MESSAGE_ID_REUSED', 'same messageId, different content');
          return;
        }
        this.settings.metrics.duplicateMessage(this.settings.consumerName);
        await this.ack(message);
        return;
      }

      const outcome = await this.settings.submit.execute(this.command(wager), {
        inbox: this.inboxEntry(wager.messageId, payloadHash),
      });
      this.settings.faults?.hit('consumer.before-ack');
      await this.ack(message);
      this.settings.logger.info('wager message processed', {
        ...fields,
        transactionId: outcome.transactionId,
        status: outcome.status,
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === 'inbox_messages_pkey') {
        // Another consumer committed the same message first.
        this.settings.metrics.duplicateMessage(this.settings.consumerName);
        await this.ack(message);
        return;
      }
      const disposition = classifyFailure(error);
      const detail = error instanceof Error ? error.message : String(error);
      switch (disposition.action) {
        case 'ack':
          this.settings.logger.warn('wager message rejected', {
            ...fields,
            reason: disposition.reason,
          });
          await this.ack(message);
          return;
        case 'dead-letter':
          await this.deadLetter(message, disposition.reason, detail);
          return;
        case 'retry':
          await this.retryLater(message, disposition.reason, fields);
          return;
      }
    }
  }

  private command(wager: WagerMessage) {
    const context: RequestContext = {
      correlationId: wager.messageId,
      causationId: wager.messageId,
      channel: 'sqs',
    };
    return { ...wager.data, context };
  }

  private inboxEntry(messageId: string, payloadHash: string): InboxMessage {
    const at = this.settings.clock.now();
    const entry = InboxMessage.receive({
      messageId,
      consumerName: this.settings.consumerName,
      payloadHash,
      receivedAt: at,
    });
    entry.markProcessed(at);
    return entry;
  }

  private async ack(message: Message): Promise<void> {
    await this.settings.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.settings.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  /** Leaves the message for redelivery after a backoff based on how often it was received. */
  private async retryLater(
    message: Message,
    reason: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const receiveCount = Math.max(1, Number(message.Attributes?.ApproximateReceiveCount ?? '1'));
    const delaySeconds = Math.ceil(this.settings.retryBackoff.delayMs(receiveCount) / 1000);
    this.settings.metrics.messageRetried(reason);
    this.settings.logger.warn('wager message will be retried', {
      ...fields,
      reason,
      receiveCount,
      delaySeconds,
    });
    await this.settings.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.settings.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: delaySeconds,
      }),
    );
  }

  /** Copies the message to the DLQ with its reason, then deletes the original. */
  private async deadLetter(message: Message, reason: string, detail: string): Promise<void> {
    await this.settings.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.settings.deadLetterQueueUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId ?? Bun.randomUUIDv7(),
        MessageAttributes: {
          'dlq-reason': { DataType: 'String', StringValue: reason },
          'dlq-detail': {
            DataType: 'String',
            StringValue: detail.slice(0, MAX_ATTRIBUTE_LENGTH) || '-',
          },
          'source-message-id': { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
        },
      }),
    );
    this.settings.metrics.deadLettered(reason);
    this.settings.logger.warn('wager message dead-lettered', {
      consumer: this.settings.consumerName,
      sqsMessageId: message.MessageId,
      reason,
    });
    await this.ack(message);
  }

  /** Makes a message that was received but not started visible again right away (shutdown). */
  private async release(message: Message): Promise<void> {
    await this.settings.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.settings.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }
}
