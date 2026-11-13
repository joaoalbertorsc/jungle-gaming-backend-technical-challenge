import {
  UniqueViolationError,
  WalletAlreadyExistsError,
} from '../../../shared/application/application-errors';
import type {
  Clock,
  FaultInjector,
  IdGenerator,
  RequestContext,
} from '../../../shared/application/ports';
import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { Wallet } from '../domain/wallet';
import { InvalidWalletOperationError } from '../domain/wallet-errors';
import { toWalletView, type WalletView } from './wallet-views';

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly context: RequestContext;
}

/**
 * POST /wallets (§9). A positive initial balance is written as an internal OPENING transaction and
 * its CREDIT entry, in the same SQL transaction as the wallet, together with WalletBalanceChanged.
 */
export class CreateWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly faults: FaultInjector,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    if (command.playerId.trim() === '') {
      throw new InvalidWalletOperationError('playerId is required');
    }
    const initialBalance = Money.from(command.initialBalance);
    const at = this.clock.now();
    const opening = initialBalance.isPositive()
      ? { entryId: this.ids.next(), transactionId: this.ids.next() }
      : undefined;

    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance,
      openingCredit: opening,
      at,
    });

    try {
      await this.unitOfWork.transaction(async ({ wallets, transactions, ledger, outbox }) => {
        wallets.add(wallet);
        if (opening !== undefined && openingEntry !== undefined) {
          transactions.add(
            WagerTransaction.opening({
              id: opening.transactionId,
              walletId: wallet.id,
              playerId: wallet.playerId,
              money: initialBalance,
              at,
            }),
          );
          ledger.append(openingEntry);
          outbox.enqueue(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, {
                eventId: this.ids.next(),
                correlationId: command.context.correlationId,
                causationId: command.context.causationId,
                occurredAt: at,
              }),
            ),
          );
        }
        this.faults.hit('wallet.before-commit');
        return Promise.resolve();
      });
    } catch (error) {
      if (
        error instanceof UniqueViolationError &&
        error.constraint === 'wallets_player_currency_key'
      ) {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }

    return toWalletView(wallet);
  }
}
