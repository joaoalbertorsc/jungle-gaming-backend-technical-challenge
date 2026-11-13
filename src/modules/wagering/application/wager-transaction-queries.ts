import { ResourceNotFoundError } from '../../../shared/application/application-errors';
import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import { toWagerTransactionView, type WagerTransactionView } from './wager-views';

/**
 * GET /wagering/transactions/:transactionId and
 * GET /providers/:providerId/wagering/transactions/:externalTransactionId (§9).
 */
export class GetWagerTransaction {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.unitOfWork.read(({ transactions }) =>
      transactions.findById(transactionId),
    );
    if (transaction === undefined) throw new ResourceNotFoundError('TRANSACTION', transactionId);
    return toWagerTransactionView(transaction);
  }

  async byProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const transaction = await this.unitOfWork.read(({ transactions }) =>
      transactions.findByProviderExternalId(providerId, externalTransactionId),
    );
    if (transaction === undefined) {
      throw new ResourceNotFoundError('TRANSACTION', `${providerId}/${externalTransactionId}`);
    }
    return toWagerTransactionView(transaction);
  }
}
