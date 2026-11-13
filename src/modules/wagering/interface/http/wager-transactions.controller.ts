import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import { MissingIdempotencyKeyError } from '../../../../shared/interface/http/http-errors';
import { CorrelationId } from '../../../../shared/interface/http/correlation-id';
import { identifierSchema, uuidSchema } from '../../../../shared/interface/schemas';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { GetWagerTransaction } from '../../application/wager-transaction-queries';
import type { WagerOutcome, WagerTransactionView } from '../../application/wager-views';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import {
  idempotencyKeySchema,
  type WagerTransactionPayload,
  wagerTransactionPayloadSchema,
} from '../wager-transaction.schema';

interface StatusSetter {
  status(code: number): unknown;
}

/**
 * Status codes for a submission (ADR-0009): the provider can tell the outcome apart without reading
 * the body. A replay keeps the status of its outcome, except PROCESSED, which is 200 (nothing new
 * was created).
 */
export function httpStatusFor(outcome: WagerOutcome): number {
  switch (outcome.status) {
    case WagerTransactionStatus.Processed:
      return outcome.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

@Controller()
export class WagerTransactionsController {
  constructor(
    private readonly submitTransaction: SubmitWagerTransaction,
    private readonly transactions: GetWagerTransaction,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body({ schema: wagerTransactionPayloadSchema }) body: WagerTransactionPayload,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<WagerOutcome> {
    const idempotencyKey = idempotencyKeySchema.safeParse(idempotencyKeyHeader);
    if (!idempotencyKey.success) throw new MissingIdempotencyKeyError();

    const outcome = await this.submitTransaction.execute({
      ...body,
      idempotencyKey: idempotencyKey.data,
      context: { correlationId, channel: 'http' },
    });
    response.status(httpStatusFor(outcome));
    return outcome;
  }

  @Get('wagering/transactions/:transactionId')
  byId(
    @Param('transactionId', { schema: uuidSchema }) transactionId: string,
  ): Promise<WagerTransactionView> {
    return this.transactions.byId(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byProviderExternalId(
    @Param('providerId', { schema: identifierSchema }) providerId: string,
    @Param('externalTransactionId', { schema: identifierSchema }) externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.transactions.byProviderExternalId(providerId, externalTransactionId);
  }
}
