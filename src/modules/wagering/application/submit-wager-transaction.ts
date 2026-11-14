import {
  IdempotencyConflictError,
  TransientInfrastructureError,
  UniqueViolationError,
  UnknownWalletError,
} from '../../../shared/application/application-errors';
import type {
  ApplicationMetrics,
  Clock,
  FaultInjector,
  IdGenerator,
  RequestContext,
} from '../../../shared/application/ports';
import type { Repositories, UnitOfWork } from '../../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import type { InboxMessage } from '../../messaging/domain/inbox-message';
import { decideIdempotency, type IdempotencyDecision } from '../domain/idempotency';
import { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { WagerTransactionProcessor } from '../domain/wager-transaction-processor';
import { InvalidWagerTransactionError } from '../domain/wagering-errors';
import { outcomeEvents, recordOutcomeEffects, resolveReference } from './wager-outcome-effects';
import { toWagerOutcome, type WagerOutcome } from './wager-views';

export interface SubmitWagerTransactionCommand {
  /** Source of truth for idempotency (§9). */
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly context: RequestContext;
}

/** A concurrent writer won one of these races; re-running the unit of work resolves it. */
const RETRYABLE_UNIQUE_CONSTRAINTS = new Set([
  'wager_transactions_idempotency_key_key',
  'wager_transactions_provider_external_key',
  'wager_transactions_single_reversal_idx',
]);

const KINDS = new Map<string, WagerTransactionKind>(
  Object.values(WagerTransactionKind).map((kind) => [kind, kind]),
);

/**
 * The single write path for wagers, shared by HTTP and SQS (§10). One SQL transaction:
 * lock the wallet → decide idempotency → apply §7 → write transaction, ledger entry, wallet and
 * outbox events → commit (ADR-0007, ADR-0008, ADR-0011).
 */
export class SubmitWagerTransaction {
  private readonly processor = new WagerTransactionProcessor();

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly faults: FaultInjector,
    private readonly metrics: ApplicationMetrics,
    /** Schedules the first worker retry of a transaction parked as PENDING_REFERENCE (ADR-0012). */
    private readonly referenceRetry: ReferenceRetryPolicy = ReferenceRetryPolicy.DEFAULT,
  ) {}

  /**
   * @param options.inbox the consumed message (SQS entry): recorded in the same SQL transaction as
   *   the effects, so a redelivery is recognised even after a crash between commit and ack (§10).
   */
  async execute(
    command: SubmitWagerTransactionCommand,
    options: { readonly inbox?: InboxMessage } = {},
  ): Promise<WagerOutcome> {
    // Validates the submission (kind, reference rules, money) and computes its payload hash.
    const probe = this.newTransaction(command);

    // Fast path: a replay needs no wallet lock. Skipped for queue messages, whose inbox row must be
    // written in a transaction even when the outcome is a replay.
    // The two lookups must share one snapshot: read separately, a concurrent commit between them
    // turns an identical retry into a false EXTERNAL_ID_REUSED conflict.
    if (options.inbox === undefined) {
      const early = await this.unitOfWork.snapshot((repositories) =>
        this.decide(repositories, probe),
      );
      if (early.type !== 'new') return this.resolveKnown(early, command.context);
    }

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.unitOfWork.transaction((repositories) => {
          if (options.inbox !== undefined) repositories.inbox.record(options.inbox);
          return this.processLocked(repositories, this.newTransaction(command), command.context);
        });
        if (!result.idempotentReplay) {
          this.metrics.transactionOutcome(command.kind, result.status, command.context.channel);
        }
        return result;
      } catch (error) {
        if (
          error instanceof UniqueViolationError &&
          RETRYABLE_UNIQUE_CONSTRAINTS.has(error.constraint ?? '') &&
          attempt < 2
        ) {
          continue;
        }
        if (error instanceof TransientInfrastructureError && error.reason === 'LOCK_TIMEOUT') {
          this.metrics.lockConflict();
        }
        throw error;
      }
    }
  }

  private async processLocked(
    repositories: Repositories,
    transaction: WagerTransaction,
    context: RequestContext,
  ): Promise<WagerOutcome> {
    // The wallet row lock serializes every operation on this wallet (ADR-0007).
    const wallet = await repositories.wallets.lockById(transaction.walletId);

    // Authoritative idempotency check, now that concurrent requests are serialized.
    const decision = await this.decide(repositories, transaction);
    if (decision.type !== 'new') return this.resolveKnown(decision, context);
    if (wallet === undefined) throw new UnknownWalletError(transaction.walletId);

    const at = this.clock.now();
    const outcome = this.processor.process({
      transaction,
      wallet,
      ...(await resolveReference(repositories.transactions, transaction)),
      ledgerEntryId: this.ids.next(),
      at,
    });

    repositories.transactions.add(
      transaction,
      outcome.type === 'pending-reference'
        ? { nextReferenceAttemptAt: this.referenceRetry.firstRetryAt(at) }
        : {},
    );
    await recordOutcomeEffects(repositories, {
      transaction,
      wallet,
      outcome,
      events: outcomeEvents(transaction, wallet, outcome, () => ({
        eventId: this.ids.next(),
        correlationId: context.correlationId,
        causationId: context.causationId,
        occurredAt: at,
      })),
      at,
    });

    this.faults.hit('wager.before-commit');
    return toWagerOutcome(transaction, false);
  }

  private async decide(
    { transactions }: Repositories,
    transaction: WagerTransaction,
  ): Promise<IdempotencyDecision> {
    const [byKey, byExternalId] = await Promise.all([
      transactions.findByIdempotencyKey(transaction.idempotencyKey),
      transactions.findByProviderExternalId(
        transaction.providerId,
        transaction.externalTransactionId,
      ),
    ]);
    return decideIdempotency(byKey, byExternalId, transaction.payloadHash);
  }

  private resolveKnown(
    decision: Exclude<IdempotencyDecision, { type: 'new' }>,
    context: RequestContext,
  ): WagerOutcome {
    if (decision.type === 'conflict') throw new IdempotencyConflictError(decision.reason);
    this.metrics.idempotentReplay(context.channel);
    return toWagerOutcome(decision.transaction, true);
  }

  private newTransaction(command: SubmitWagerTransactionCommand): WagerTransaction {
    const kind = KINDS.get(command.kind);
    if (kind === undefined) {
      throw new InvalidWagerTransactionError('UNKNOWN_KIND', `unknown kind ${command.kind}`);
    }
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });
  }
}
