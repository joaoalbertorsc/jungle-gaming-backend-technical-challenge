import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  PendingReferenceClaim,
  PendingReferenceQueue,
} from '../../modules/wagering/application/ports';

interface ClaimRow {
  id: string;
  wallet_id: string;
  reference_attempts: number;
  created_at: Date | string;
}

/**
 * PostgreSQL side of the retry worker (ADR-0012): one autocommit UPDATE claims due rows, so no
 * lock outlives the statement; the lease in `next_reference_attempt_at` prevents double claims.
 */
export class MikroOrmPendingReferenceQueue implements PendingReferenceQueue {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<PendingReferenceClaim[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows: ClaimRow[] = await this.orm.em.fork().execute(
      `UPDATE wager_transactions AS t
          SET next_reference_attempt_at = ?
         FROM (SELECT id FROM wager_transactions
                WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= ?
                ORDER BY next_reference_attempt_at, created_at, id
                LIMIT ?
                FOR UPDATE SKIP LOCKED) AS due
        WHERE t.id = due.id
        RETURNING t.id, t.wallet_id, t.reference_attempts, t.created_at`,
      [leaseUntil, now, limit],
    );
    // Arrival order, so a worker retries the transactions of one wallet as they were delivered.
    return rows
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .map((row) => ({
        transactionId: row.id,
        walletId: row.wallet_id,
        attempts: row.reference_attempts,
      }));
  }
}
