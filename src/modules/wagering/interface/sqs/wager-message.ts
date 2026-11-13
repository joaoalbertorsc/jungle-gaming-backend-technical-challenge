import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../../../shared/domain/canonical-json';
import { identifierSchema } from '../../../../shared/interface/schemas';
import { idempotencyKeySchema, wagerTransactionPayloadSchema } from '../wager-transaction.schema';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/** The §10 message: an envelope around the same payload the HTTP API accepts, plus its key. */
export const wagerMessageSchema = z
  .object({
    messageId: identifierSchema,
    type: z.literal(WAGER_MESSAGE_TYPE),
    occurredAt: z.iso.datetime(),
    data: wagerTransactionPayloadSchema.extend({ idempotencyKey: idempotencyKeySchema }),
  })
  .strict();

export type WagerMessage = z.infer<typeof wagerMessageSchema>;

export type ParsedWagerMessage =
  | {
      readonly ok: true;
      readonly message: WagerMessage;
      /** SHA-256 of the canonical JSON of the message: the inbox fingerprint. */
      readonly payloadHash: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'MALFORMED_MESSAGE' | 'INVALID_MESSAGE';
      readonly detail: string;
    };

/** Parses and validates a raw SQS body. Failures are permanent: the message goes to the DLQ. */
export function parseWagerMessage(body: string): ParsedWagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'MALFORMED_MESSAGE', detail: 'the body is not valid JSON' };
  }

  const result = wagerMessageSchema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason: 'INVALID_MESSAGE', detail };
  }

  return {
    ok: true,
    message: result.data,
    payloadHash: createHash('sha256').update(canonicalJson(result.data), 'utf8').digest('hex'),
  };
}
