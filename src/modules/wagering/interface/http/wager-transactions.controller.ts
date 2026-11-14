import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { APPLICATION_LOGGER, type ApplicationLogger } from '../../../../shared/application/ports';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MissingIdempotencyKeyError } from '../../../../shared/interface/http/http-errors';
import {
  ApiBodyExamples,
  ApiCorrelationId,
  ApiProblems,
} from '../../../../shared/interface/http/openapi';
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
import {
  SUBMIT_WAGER_EXAMPLES,
  unprocessableSubmissionSchema,
  wagerOutcomeSchema,
  wagerTransactionViewSchema,
} from './wager.openapi';

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

@ApiTags('Wagering')
@ApiCorrelationId()
@Controller()
export class WagerTransactionsController {
  constructor(
    private readonly submitTransaction: SubmitWagerTransaction,
    private readonly transactions: GetWagerTransaction,
    @Inject(APPLICATION_LOGGER) private readonly logger: ApplicationLogger,
  ) {}

  @Post('wagering/transactions')
  @ApiOperation({
    summary: 'Submit a wager transaction (BET, WIN, LOSS, REFUND, ROLLBACK)',
    description:
      'Idempotent: the same Idempotency-Key with the same payload replays the stored outcome. ' +
      'The status code tells the outcome apart without reading the body. A REFUND or ROLLBACK ' +
      'whose reference has not arrived yet is parked (202) and settled by the retry worker.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique per operation; recommended `{providerId}:{externalTransactionId}`',
    schema: { type: 'string', example: 'provider-a:bet-1001' },
  })
  @ApiBodyExamples(SUBMIT_WAGER_EXAMPLES)
  @ApiResponse({
    status: 201,
    description: 'PROCESSED: new transaction applied',
    standardSchema: wagerOutcomeSchema,
  })
  @ApiResponse({
    status: 200,
    description: 'Idempotent replay of a PROCESSED transaction (`idempotentReplay: true`)',
    standardSchema: wagerOutcomeSchema,
  })
  @ApiResponse({
    status: 202,
    description: 'PENDING_REFERENCE: the referenced transaction has not arrived; it is retried',
    standardSchema: wagerOutcomeSchema,
  })
  @ApiResponse({
    status: 422,
    description:
      'REJECTED by a business rule (outcome with `failureCode`, also on replay), or Problem ' +
      'Details for WALLET_NOT_FOUND and CURRENCY_MISMATCH',
    standardSchema: unprocessableSubmissionSchema,
  })
  @ApiProblems(400, 409, 503)
  async submit(
    @Body({ schema: wagerTransactionPayloadSchema }) body: WagerTransactionPayload,
    @Headers('Idempotency-Key') idempotencyKeyHeader: string | undefined,
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
    // Identifiers and the outcome only: the amount and the rest of the payload stay out (§12).
    this.logger.info('wager transaction processed', {
      correlationId,
      transactionId: outcome.transactionId,
      walletId: body.walletId,
      providerId: body.providerId,
      kind: body.kind,
      status: outcome.status,
      failureCode: outcome.failureCode,
      idempotentReplay: outcome.idempotentReplay,
      channel: 'http',
    });
    return outcome;
  }

  @Get('wagering/transactions/:transactionId')
  @ApiOperation({ summary: 'Get a transaction by its id' })
  @ApiResponse({
    status: 200,
    description: 'The transaction',
    standardSchema: wagerTransactionViewSchema,
  })
  @ApiProblems(400, 404)
  byId(
    @Param('transactionId', { schema: uuidSchema }) transactionId: string,
  ): Promise<WagerTransactionView> {
    return this.transactions.byId(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({ summary: "Get a transaction by the provider's external id" })
  @ApiResponse({
    status: 200,
    description: 'The transaction',
    standardSchema: wagerTransactionViewSchema,
  })
  @ApiProblems(400, 404)
  byProviderExternalId(
    @Param('providerId', { schema: identifierSchema }) providerId: string,
    @Param('externalTransactionId', { schema: identifierSchema }) externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.transactions.byProviderExternalId(providerId, externalTransactionId);
  }
}
