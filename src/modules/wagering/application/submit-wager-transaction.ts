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
import { ExponentialBackoff } from '../../../shared/domain/exponential-backoff';
import type { EventContext } from '../../../shared/domain/integration-event';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import type { InboxMessage } from '../../messaging/domain/inbox-message';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed';
import type { Wallet } from '../../wallet/domain/wallet';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wager-transaction-events';
import { decideIdempotency, type IdempotencyDecision } from '../domain/idempotency';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import {
  type ProcessWagerOutcome,
  WagerTransactionProcessor,
} from '../domain/wager-transaction-processor';
import { InvalidWagerTransactionError } from '../domain/wagering-errors';
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

/** First retry of a PENDING_REFERENCE transaction (the full policy lives with the worker, ADR-0012). */
export const REFERENCE_RETRY_BACKOFF = new ExponentialBackoff({
  baseMs: 1_000,
  factor: 2,
  maxMs: 300_000,
});

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
    if (options.inbox === undefined) {
      const early = await this.unitOfWork.read((repositories) => this.decide(repositories, probe));
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
    const { wallets, transactions, ledger, outbox } = repositories;

    // The wallet row lock serializes every operation on this wallet (ADR-0007).
    const wallet = await wallets.lockById(transaction.walletId);

    // Authoritative idempotency check, now that concurrent requests are serialized.
    const decision = await this.decide(repositories, transaction);
    if (decision.type !== 'new') return this.resolveKnown(decision, context);
    if (wallet === undefined) throw new UnknownWalletError(transaction.walletId);

    const reference =
      transaction.referenceExternalTransactionId === undefined
        ? undefined
        : await transactions.findByProviderExternalId(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          );
    const referenceAlreadyReversed =
      reference !== undefined && transaction.isReversal()
        ? await transactions.isReversed(reference.id)
        : false;

    const at = this.clock.now();
    const outcome = this.processor.process({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      at,
    });

    transactions.add(
      transaction,
      outcome.type === 'pending-reference'
        ? { nextReferenceAttemptAt: REFERENCE_RETRY_BACKOFF.nextAttemptAt(at, 1) }
        : {},
    );
    if (outcome.type === 'processed' && outcome.ledgerEntry !== undefined) {
      ledger.append(outcome.ledgerEntry);
      wallets.save(wallet);
    }
    outbox.enqueue(...this.events(transaction, wallet, outcome, context, at));

    // Transactions parked on this one can be retried right away (ADR-0012).
    if (transaction.isTerminal()) {
      await transactions.nudgeWaitingOn(
        transaction.providerId,
        transaction.externalTransactionId,
        at,
      );
    }

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

  private events(
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: ProcessWagerOutcome,
    context: RequestContext,
    at: Date,
  ): OutboxMessage[] {
    const eventContext = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: at,
    });

    switch (outcome.type) {
      case 'processed':
        return [
          OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, eventContext())),
          ...(outcome.ledgerEntry === undefined
            ? []
            : [
                OutboxMessage.enqueue(
                  WalletBalanceChanged.from(wallet, outcome.ledgerEntry, eventContext()),
                ),
              ]),
        ];
      case 'rejected':
        return [OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, eventContext()))];
      case 'pending-reference':
        return [
          OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, eventContext())),
        ];
    }
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
