import { ResourceNotFoundError } from '../../../shared/application/application-errors';
import type { ApplicationLogger, ApplicationMetrics } from '../../../shared/application/ports';
import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import type { MoneyProps } from '../../../shared/domain/money';

export interface ReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  /** storedBalance − calculatedBalance. */
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

/**
 * POST /wallets/:walletId/reconciliation (§9, ADR-0013). Reads the wallet and its ledger from one
 * REPEATABLE READ snapshot. A divergence is logged, counted and reported, never corrected.
 */
export class ReconcileWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly logger: ApplicationLogger,
    private readonly metrics: ApplicationMetrics,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const { wallet, summary } = await this.unitOfWork.snapshot(async ({ wallets, ledger }) => {
      const found = await wallets.findById(walletId);
      if (found === undefined) throw new ResourceNotFoundError('WALLET', walletId);
      return { wallet: found, summary: await ledger.summarize(walletId, found.currency) };
    });

    const difference = wallet.balance.subtract(summary.balance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.reconciliationMismatch();
      this.logger.error('wallet balance diverges from its ledger', {
        walletId,
        difference: difference.amount,
        currency: wallet.currency,
        checkedEntries: summary.entries,
      });
    }

    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: summary.balance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: summary.entries,
    };
  }
}
