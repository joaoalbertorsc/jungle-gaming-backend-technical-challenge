import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { integrationEnv, uniqueRunId } from '../../support/integration-env';

/**
 * Contract tests for the SQS emulator (phase 0).
 * They pin down every SQS behaviour the consumer and the outbox relay depend on, so the
 * emulator choice (MiniStack vs LocalStack) is decided by evidence.
 * See docs/adr/0016-sqs-emulator.md.
 */
const MAX_RECEIVE_COUNT = 2;
const runId = uniqueRunId();

const sqs = new SQSClient({
  endpoint: integrationEnv.sqsEndpoint,
  region: integrationEnv.awsRegion,
});

let queueUrl: string;
let dlqUrl: string;

async function createFifoQueue(name: string, attributes: Record<string, string> = {}) {
  const result = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', VisibilityTimeout: '30', ...attributes },
    }),
  );
  if (result.QueueUrl === undefined) throw new Error(`queue ${name} has no URL`);
  return result.QueueUrl;
}

async function queueArn(url: string): Promise<string> {
  const result = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
  );
  const arn = result.Attributes?.QueueArn;
  if (arn === undefined) throw new Error(`queue ${url} has no ARN`);
  return arn;
}

async function send(body: string, groupId: string, deduplicationId: string) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

async function receive(url: string, max = 10): Promise<Message[]> {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }),
  );
  return result.Messages ?? [];
}

async function release(url: string, message: Message) {
  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: url,
      ReceiptHandle: message.ReceiptHandle,
      VisibilityTimeout: 0,
    }),
  );
}

async function ack(url: string, message: Message) {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
}

/** Leaves the queue empty so each test starts from a clean state. */
async function drain(url: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const messages = await receive(url);
    if (messages.length === 0) return;
    await Promise.all(messages.map((m) => ack(url, m)));
  }
}

describe('SQS emulator contract', () => {
  beforeAll(async () => {
    dlqUrl = await createFifoQueue(`contract-${runId}-dlq.fifo`);
    queueUrl = await createFifoQueue(`contract-${runId}.fifo`, {
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: await queueArn(dlqUrl),
        maxReceiveCount: MAX_RECEIVE_COUNT,
      }),
    });
  });

  afterAll(async () => {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    sqs.destroy();
  });

  it('creates a FIFO queue whose redrive policy points to the DLQ', async () => {
    const result = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['FifoQueue', 'RedrivePolicy'],
      }),
    );

    expect(result.Attributes?.FifoQueue).toBe('true');
    const redrive = JSON.parse(result.Attributes?.RedrivePolicy ?? '{}') as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: number | string;
    };
    expect(redrive.deadLetterTargetArn).toBe(await queueArn(dlqUrl));
    expect(Number(redrive.maxReceiveCount)).toBe(MAX_RECEIVE_COUNT);
  });

  it('drops a second message with the same MessageDeduplicationId', async () => {
    await send('first', 'group-dedup', 'dedup-1');
    await send('duplicate', 'group-dedup', 'dedup-1');

    const messages = await receive(queueUrl);

    expect(messages.map((m) => m.Body)).toEqual(['first']);
    await Promise.all(messages.map((m) => ack(queueUrl, m)));
    await drain(queueUrl);
  });

  it('delivers messages of the same group in send order', async () => {
    for (const body of ['a', 'b', 'c']) await send(body, 'group-order', `order-${body}`);

    const bodies: string[] = [];
    for (let attempt = 0; attempt < 5 && bodies.length < 3; attempt++) {
      for (const message of await receive(queueUrl)) {
        bodies.push(message.Body ?? '');
        await ack(queueUrl, message);
      }
    }

    expect(bodies).toEqual(['a', 'b', 'c']);
  });

  it('hides an in-flight message and redelivers it once its visibility is released', async () => {
    await send('in-flight', 'group-visibility', 'visibility-1');

    const [first] = await receive(queueUrl, 1);
    expect(first?.Body).toBe('in-flight');
    expect(first?.Attributes?.ApproximateReceiveCount).toBe('1');
    expect(await receive(queueUrl, 1)).toEqual([]);

    await release(queueUrl, first as Message);
    const [redelivered] = await receive(queueUrl, 1);

    expect(redelivered?.Body).toBe('in-flight');
    expect(redelivered?.Attributes?.ApproximateReceiveCount).toBe('2');
    await ack(queueUrl, redelivered as Message);
  });

  it('does not redeliver a message after it is deleted (ack)', async () => {
    await send('acked', 'group-ack', 'ack-1');
    const [message] = await receive(queueUrl, 1);
    await ack(queueUrl, message as Message);

    expect(await receive(queueUrl)).toEqual([]);
  });

  it(`moves a message to the DLQ after ${String(MAX_RECEIVE_COUNT)} receives without ack`, async () => {
    await send('poison', 'group-dlq', 'dlq-1');

    for (let receiveCount = 1; receiveCount <= MAX_RECEIVE_COUNT; receiveCount++) {
      const [message] = await receive(queueUrl, 1);
      expect(message?.Body).toBe('poison');
      await release(queueUrl, message as Message);
    }

    expect(await receive(queueUrl)).toEqual([]);
    const deadLettered = await receive(dlqUrl);
    expect(deadLettered.map((m) => m.Body)).toEqual(['poison']);
    await Promise.all(deadLettered.map((m) => ack(dlqUrl, m)));
  });
});
