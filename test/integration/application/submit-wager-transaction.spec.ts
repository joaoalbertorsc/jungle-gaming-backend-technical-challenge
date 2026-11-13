import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SubmitWagerTransactionCommand } from '../../../src/modules/wagering/application/submit-wager-transaction';
import { FailureCode } from '../../../src/modules/wagering/domain/failure-code';
import { WagerTransactionStatus as Status } from '../../../src/modules/wagering/domain/wager-transaction';
import { InvalidWagerTransactionError } from '../../../src/modules/wagering/domain/wagering-errors';
import {
  IdempotencyConflictError,
  TransientInfrastructureError,
  UnknownWalletError,
} from '../../../src/shared/application/application-errors';
import {
  assertLedgerMatchesBalance,
  count,
  createTestApplication,
  FailAt,
  httpContext,
  outboxEventTypes,
  type TestApplication,
} from '../../support/application';
import { rejectionOf } from '../../support/assertions';
import { TestDatabase } from '../../support/test-database';

const brl = (amount: string) => ({ amount, currency: 'BRL' });
let sequence = 0;
const nextExternalId = (prefix = 'tx') => `${prefix}-${String(++sequence)}-${Bun.randomUUIDv7()}`;

/** §7 and §9 end to end through the use case, against real PostgreSQL. */
describe('SubmitWagerTransaction', () => {
  let db: TestDatabase;
  let app: TestApplication;

  beforeAll(async () => {
    db = await TestDatabase.create();
    app = await createTestApplication(db);
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  async function openWallet(balance: string) {
    return app.createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: brl(balance),
      context: httpContext,
    });
  }

  function command(
    wallet: { id: string; playerId: string },
    overrides: Partial<SubmitWagerTransactionCommand> = {},
  ): SubmitWagerTransactionCommand {
    const externalTransactionId = overrides.externalTransactionId ?? nextExternalId();
    return {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl('25.00'),
      context: httpContext,
      ...overrides,
    };
  }

  describe('BET', () => {
    it('debits the wallet and commits transaction, ledger entry and events together', async () => {
      const wallet = await openWallet('1000.00');

      const outcome = await app.submit.execute(command(wallet));

      expect(outcome).toEqual({
        transactionId: expect.any(String),
        status: Status.Processed,
        balance: brl('975.00'),
        idempotentReplay: false,
      });
      expect(
        await count(db.app, 'wallet_ledger_entries', { transaction_id: outcome.transactionId }),
      ).toBe(1);
      expect(await outboxEventTypes(db.app, [outcome.transactionId])).toEqual([
        'WagerTransactionProcessed',
      ]);
      // Opening credit + this debit.
      expect(await outboxEventTypes(db.app, [wallet.id])).toEqual([
        'WalletBalanceChanged',
        'WalletBalanceChanged',
      ]);
      await assertLedgerMatchesBalance(db.app, wallet.id);
    });

    it('is persisted as REJECTED with INSUFFICIENT_FUNDS, without ledger entry', async () => {
      const wallet = await openWallet('20.00');

      const outcome = await app.submit.execute(command(wallet, { money: brl('80.00') }));

      expect(outcome).toEqual({
        transactionId: expect.any(String),
        status: Status.Rejected,
        failureCode: FailureCode.InsufficientFunds,
        balance: brl('20.00'),
        idempotentReplay: false,
      });
      expect(
        await count(db.app, 'wallet_ledger_entries', { transaction_id: outcome.transactionId }),
      ).toBe(0);
      expect(await outboxEventTypes(db.app, [outcome.transactionId])).toEqual([
        'WagerTransactionRejected',
      ]);
      await assertLedgerMatchesBalance(db.app, wallet.id);
    });
  });

  describe('idempotency (§9)', () => {
    it('replays an identical request: same outcome, balance observed then, nothing written again', async () => {
      const wallet = await openWallet('100.00');
      const bet = command(wallet, { money: brl('30.00') });
      const first = await app.submit.execute(bet);
      await app.submit.execute(command(wallet, { money: brl('10.00') }));

      const replay = await app.submit.execute(bet);

      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect(replay.balance).toEqual(brl('70.00'));
      expect(
        await count(db.app, 'wallet_ledger_entries', { transaction_id: first.transactionId }),
      ).toBe(1);
      expect(await outboxEventTypes(db.app, [first.transactionId])).toEqual([
        'WagerTransactionProcessed',
      ]);
      expect(app.metrics.calls).toContain('replay:http');
    });

    it('replays a rejected request as the same rejection', async () => {
      const wallet = await openWallet('5.00');
      const bet = command(wallet, { money: brl('50.00') });
      const first = await app.submit.execute(bet);

      expect(await app.submit.execute(bet)).toEqual({ ...first, idempotentReplay: true });
    });

    it('treats the same key with a different payload as a conflict, not a replay', async () => {
      const wallet = await openWallet('100.00');
      const bet = command(wallet);
      await app.submit.execute(bet);

      expect(await rejectionOf(app.submit.execute({ ...bet, money: brl('26.00') }))).toMatchObject({
        constructor: IdempotencyConflictError,
        reason: 'PAYLOAD_MISMATCH',
      });
      await assertLedgerMatchesBalance(db.app, wallet.id);
    });

    it('treats a reused external id under another key as a conflict', async () => {
      const wallet = await openWallet('100.00');
      const bet = command(wallet);
      await app.submit.execute(bet);

      expect(
        await rejectionOf(
          app.submit.execute({ ...bet, idempotencyKey: `other:${bet.externalTransactionId}` }),
        ),
      ).toMatchObject({
        constructor: IdempotencyConflictError,
        reason: 'EXTERNAL_ID_REUSED',
      });
    });
  });

  describe('LOSS, WIN', () => {
    it('LOSS is processed without ledger entry and only emits WagerTransactionProcessed', async () => {
      const wallet = await openWallet('100.00');

      const outcome = await app.submit.execute(command(wallet, { kind: 'LOSS' }));

      expect(outcome).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
      expect(
        await count(db.app, 'wallet_ledger_entries', { transaction_id: outcome.transactionId }),
      ).toBe(0);
      expect(await outboxEventTypes(db.app, [outcome.transactionId])).toEqual([
        'WagerTransactionProcessed',
      ]);
    });

    it('WIN referencing the round BET credits the wallet', async () => {
      const wallet = await openWallet('100.00');
      const bet = command(wallet);
      await app.submit.execute(bet);

      const outcome = await app.submit.execute(
        command(wallet, {
          kind: 'WIN',
          money: brl('60.00'),
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );

      expect(outcome).toMatchObject({ status: 'PROCESSED', balance: brl('135.00') });
      await assertLedgerMatchesBalance(db.app, wallet.id);
    });
  });

  describe('REFUND and ROLLBACK', () => {
    it('REFUND credits back a processed BET, once', async () => {
      const wallet = await openWallet('100.00');
      const bet = command(wallet);
      await app.submit.execute(bet);
      const refund = (externalTransactionId: string) =>
        command(wallet, {
          kind: 'REFUND',
          externalTransactionId,
          referenceExternalTransactionId: bet.externalTransactionId,
        });

      const first = await app.submit.execute(refund(nextExternalId('refund')));
      const second = await app.submit.execute(refund(nextExternalId('refund')));

      expect(first).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
      expect(second).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
      await assertLedgerMatchesBalance(db.app, wallet.id);
    });

    it('ROLLBACK after a REFUND of the same BET is rejected: no double credit', async () => {
      const wallet = await openWallet('100.00');
      const bet = command(wallet);
      await app.submit.execute(bet);
      await app.submit.execute(
        command(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );

      const rollback = await app.submit.execute(
        command(wallet, {
          kind: 'ROLLBACK',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );

      expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
      await assertLedgerMatchesBalance(db.app, wallet.id);
    });

    it('ROLLBACK of a WIN that would overdraw is rejected with REVERSAL_WOULD_OVERDRAW', async () => {
      const wallet = await openWallet('10.00');
      const win = command(wallet, { kind: 'WIN', money: brl('50.00') });
      await app.submit.execute(win);
      await app.submit.execute(command(wallet, { money: brl('55.00') }));

      const rollback = await app.submit.execute(
        command(wallet, {
          kind: 'ROLLBACK',
          money: brl('50.00'),
          referenceExternalTransactionId: win.externalTransactionId,
        }),
      );

      expect(rollback).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REVERSAL_WOULD_OVERDRAW',
        balance: brl('5.00'),
      });
      await assertLedgerMatchesBalance(db.app, wallet.id);
    });
  });

  describe('reference delivered before the referenced transaction (§7 rule 8)', () => {
    it('parks the REFUND as PENDING_REFERENCE, schedules a retry and emits the event', async () => {
      const wallet = await openWallet('100.00');
      const betId = nextExternalId('bet');

      const outcome = await app.submit.execute(
        command(wallet, { kind: 'REFUND', referenceExternalTransactionId: betId }),
      );

      expect(outcome).toMatchObject({ status: 'PENDING_REFERENCE', balance: brl('100.00') });
      const [row] = await db.app`
        SELECT next_reference_attempt_at IS NOT NULL AS scheduled FROM wager_transactions
        WHERE id = ${outcome.transactionId}`;
      expect(row).toEqual({ scheduled: true });
      expect(await outboxEventTypes(db.app, [outcome.transactionId])).toEqual([
        'WagerTransactionPendingReference',
      ]);
    });

    it('nudges the parked REFUND when its BET arrives', async () => {
      const wallet = await openWallet('100.00');
      const betId = nextExternalId('bet');
      const refund = await app.submit.execute(
        command(wallet, { kind: 'REFUND', referenceExternalTransactionId: betId }),
      );
      await db.app`UPDATE wager_transactions SET next_reference_attempt_at = now() + interval '1 hour'
                   WHERE id = ${refund.transactionId}`;

      await app.submit.execute(command(wallet, { externalTransactionId: betId }));

      const [row] = await db.app`
        SELECT next_reference_attempt_at <= now() AS due FROM wager_transactions
        WHERE id = ${refund.transactionId}`;
      expect(row).toEqual({ due: true });
    });
  });

  describe('invalid submissions', () => {
    it('refuses an unknown wallet without persisting anything', async () => {
      const ghost = { id: Bun.randomUUIDv7(), playerId: 'nobody' };

      expect(await rejectionOf(app.submit.execute(command(ghost)))).toBeInstanceOf(
        UnknownWalletError,
      );
      expect(await count(db.app, 'wager_transactions', { wallet_id: ghost.id })).toBe(0);
    });

    it('refuses OPENING from outside', async () => {
      const wallet = await openWallet('100.00');

      expect(
        await rejectionOf(app.submit.execute(command(wallet, { kind: 'OPENING' }))),
      ).toBeInstanceOf(InvalidWagerTransactionError);
    });
  });

  describe('atomicity and transient failures', () => {
    it('a failure before commit leaves no transaction, entry, balance change or event', async () => {
      const failing = await createTestApplication(db, {
        faults: new FailAt('wager.before-commit'),
      });
      const wallet = await openWallet('100.00');
      const bet = command(wallet);

      try {
        expect(await rejectionOf(failing.submit.execute(bet))).toHaveProperty(
          'message',
          expect.stringContaining('injected fault'),
        );

        expect(
          await count(db.app, 'wager_transactions', {
            external_transaction_id: bet.externalTransactionId,
          }),
        ).toBe(0);
        const [row] =
          await db.app`SELECT balance::text, version FROM wallets WHERE id = ${wallet.id}`;
        expect(row).toEqual({ balance: '100.00', version: 1 });
        expect(await outboxEventTypes(db.app, [wallet.id])).toEqual(['WalletBalanceChanged']);
      } finally {
        await failing.close();
      }
    });

    it('turns a wallet lock held too long into a retryable LOCK_TIMEOUT', async () => {
      const impatient = await createTestApplication(db, { lockTimeoutMs: 200 });
      const wallet = await openWallet('100.00');
      const holder = await db.app.reserve();

      try {
        await holder`BEGIN`;
        await holder`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;

        expect(await rejectionOf(impatient.submit.execute(command(wallet)))).toMatchObject({
          constructor: TransientInfrastructureError,
          reason: 'LOCK_TIMEOUT',
        });
        expect(impatient.metrics.calls).toContain('lock-conflict');
      } finally {
        await holder`ROLLBACK`;
        await holder.release();
        await impatient.close();
      }
    });
  });
});
