import { ResourceNotFoundError } from '../../../shared/application/application-errors';
import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';
import {
  type LedgerEntryView,
  toLedgerEntryView,
  toWalletView,
  type WalletView,
} from './wallet-views';

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 200;

/** GET /wallets/:walletId */
export class GetWallet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.unitOfWork.read(({ wallets }) => wallets.findById(walletId));
    if (wallet === undefined) throw new ResourceNotFoundError('WALLET', walletId);
    return toWalletView(wallet);
  }
}

export interface LedgerPage {
  readonly entries: readonly LedgerEntryView[];
  /** Opaque cursor for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

/** GET /wallets/:walletId/ledger?cursor=...&limit=50 (ADR-0013). */
export class GetWalletLedger {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(query: {
    readonly walletId: string;
    readonly limit?: number;
    readonly cursor?: string | undefined;
  }): Promise<LedgerPage> {
    const afterVersion = decodeLedgerCursor(query.cursor);
    const limit = Math.min(Math.max(query.limit ?? LEDGER_PAGE_DEFAULT, 1), LEDGER_PAGE_MAX);

    return this.unitOfWork.snapshot(async ({ wallets, ledger }) => {
      if ((await wallets.findById(query.walletId)) === undefined) {
        throw new ResourceNotFoundError('WALLET', query.walletId);
      }
      // One extra row tells whether another page exists without a count query.
      const entries = await ledger.page(query.walletId, afterVersion, limit + 1);
      const page = entries.slice(0, limit);
      const last = page.at(-1);
      return {
        entries: page.map(toLedgerEntryView),
        nextCursor:
          entries.length > limit && last !== undefined
            ? encodeLedgerCursor(last.walletVersion)
            : null,
      };
    });
  }
}
