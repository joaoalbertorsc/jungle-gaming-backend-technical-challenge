import type { Repositories } from '../../../shared/application/unit-of-work';
import type { EventContext } from '../../../shared/domain/integration-event';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed';
import type { Wallet } from '../../wallet/domain/wallet';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wager-transaction-events';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { ProcessWagerOutcome } from '../domain/wager-transaction-processor';
import type { WagerTransactionRepository } from './ports';

export interface ResolvedReference {
  readonly reference: WagerTransaction | undefined;
  readonly referenceAlreadyReversed: boolean;
}

/** Looks up what `transaction` references (§7 rules 3 to 5). Call it under the wallet lock. */
export async function resolveReference(
  transactions: WagerTransactionRepository,
  transaction: WagerTransaction,
): Promise<ResolvedReference> {
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
  return { reference, referenceAlreadyReversed };
}

/** The events of one processed, rejected or parked transaction (§11). */
export function outcomeEvents(
  transaction: WagerTransaction,
  wallet: Wallet,
  outcome: ProcessWagerOutcome,
  nextContext: () => EventContext,
): OutboxMessage[] {
  switch (outcome.type) {
    case 'processed':
      return [
        OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, nextContext())),
        ...(outcome.ledgerEntry === undefined
          ? []
          : [
              OutboxMessage.enqueue(
                WalletBalanceChanged.from(wallet, outcome.ledgerEntry, nextContext()),
              ),
            ]),
      ];
    case 'rejected':
      return [OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, nextContext()))];
    case 'pending-reference':
      return [
        OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, nextContext())),
      ];
  }
}

/**
 * Writes what an outcome implies besides the transaction row: the ledger entry and wallet balance
 * when money moved, the events, and the nudge for transactions parked on this one (ADR-0012).
 */
export async function recordOutcomeEffects(
  { wallets, transactions, ledger, outbox }: Repositories,
  effects: {
    readonly transaction: WagerTransaction;
    readonly wallet: Wallet;
    readonly outcome: ProcessWagerOutcome;
    readonly events: readonly OutboxMessage[];
    readonly at: Date;
  },
): Promise<void> {
  const { transaction, wallet, outcome, events, at } = effects;
  if (outcome.type === 'processed' && outcome.ledgerEntry !== undefined) {
    ledger.append(outcome.ledgerEntry);
    wallets.save(wallet);
  }
  outbox.enqueue(...events);

  if (transaction.isTerminal()) {
    await transactions.nudgeWaitingOn(
      transaction.providerId,
      transaction.externalTransactionId,
      at,
    );
  }
}
