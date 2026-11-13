import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../../src/modules/wagering/domain/wager-transaction';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import { Money } from '../../../src/shared/domain/money';

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export const T0 = new Date('2026-07-29T15:00:00.000Z');
export const T1 = new Date('2026-07-29T15:00:01.000Z');

export const WALLET_ID = 'wallet-1';
export const PLAYER_ID = 'player-1';
export const PROVIDER_ID = 'provider-a';
export const ROUND_ID = 'round-987';

let sequence = 0;
const next = (prefix: string): string => {
  sequence += 1;
  return `${prefix}-${String(sequence)}`;
};

/** Valid creation props for a wager transaction; override any field per test. */
export function wagerProps(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  const externalTransactionId = overrides.externalTransactionId ?? next('ext');
  const requiresReference =
    kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  return {
    id: next('tx'),
    providerId: PROVIDER_ID,
    externalTransactionId,
    idempotencyKey: `${overrides.providerId ?? PROVIDER_ID}:${externalTransactionId}`,
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: ROUND_ID,
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    referenceExternalTransactionId: requiresReference ? 'ext-referenced' : undefined,
    createdAt: T0,
    ...overrides,
  };
}

export function aWager(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create(wagerProps(kind, overrides));
}

/** A wager already PROCESSED (e.g. the referenced BET of a REFUND). */
export function aProcessedWager(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const transaction = aWager(kind, overrides);
  transaction.markProcessed({
    referenceTransactionId: undefined,
    resultingBalance: brl('0.00'),
    at: T0,
  });
  return transaction;
}

export function aWallet(
  balance: string,
  overrides: { currency?: string; playerId?: string } = {},
): Wallet {
  return Wallet.rehydrate({
    id: WALLET_ID,
    playerId: overrides.playerId ?? PLAYER_ID,
    currency: overrides.currency ?? 'BRL',
    balance: Money.from({ amount: balance, currency: overrides.currency ?? 'BRL' }),
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
}
