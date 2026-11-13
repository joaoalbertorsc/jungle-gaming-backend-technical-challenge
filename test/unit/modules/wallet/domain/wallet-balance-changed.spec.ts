import { describe, expect, it } from 'bun:test';
import { WalletBalanceChanged } from '../../../../../src/modules/wallet/domain/events/wallet-balance-changed';
import { Wallet } from '../../../../../src/modules/wallet/domain/wallet';
import { InvalidWalletOperationError } from '../../../../../src/modules/wallet/domain/wallet-errors';
import { LedgerDirection } from '../../../../../src/modules/wallet/domain/wallet-ledger-entry';
import { brl, T0, T1 } from '../../../../support/builders/wagering';

const context = { eventId: 'event-1', correlationId: 'corr-1', occurredAt: T1 };

function walletWithDebit() {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('1000.00'),
    openingCredit: { entryId: 'entry-0', transactionId: 'tx-0' },
    at: T0,
  });
  const entry = wallet.debit({
    entryId: 'entry-1',
    transactionId: 'tx-1',
    money: brl('25.00'),
    at: T1,
  });
  return { wallet, entry };
}

describe('WalletBalanceChanged', () => {
  it('describes the movement with decimal-string money, never Money instances', () => {
    const { wallet, entry } = walletWithDebit();

    const event = WalletBalanceChanged.from(wallet, entry, context);

    expect(event.toJSON()).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      occurredAt: T1.toISOString(),
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '1000.00', currency: 'BRL' },
        balanceAfter: { amount: '975.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('refuses a ledger entry from another wallet', () => {
    const { entry } = walletWithDebit();
    const { wallet: other } = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-2',
      initialBalance: brl('0.00'),
      at: T0,
    });

    expect(() => WalletBalanceChanged.from(other, entry, context)).toThrow(
      InvalidWalletOperationError,
    );
  });
});
