import { Migration } from '@mikro-orm/migrations';

/**
 * Wager transactions: idempotency, per-kind reference rules, outcome consistency, the single-reversal
 * index and the state machine guard (ADR-0006, ADR-0008, ADR-0009, ADR-0012).
 */
const KINDS = `'OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'`;
const STATUSES = `'PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'`;
const FAILURE_CODES = [
  'INSUFFICIENT_FUNDS',
  'REVERSAL_WOULD_OVERDRAW',
  'CURRENCY_MISMATCH',
  'WALLET_PLAYER_MISMATCH',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_MISMATCH',
  'INVALID_REFERENCE_KIND',
  'REFERENCE_NOT_PROCESSED',
  'ALREADY_REVERSED',
  'AMOUNT_MISMATCH',
  'PROCESSING_FAILED',
]
  .map((code) => `'${code}'`)
  .join(', ');

const UP = [
  `CREATE TABLE wager_transactions (
     id UUID PRIMARY KEY,
     provider_id TEXT NOT NULL,
     external_transaction_id TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     payload_hash TEXT NOT NULL
       CONSTRAINT wager_transactions_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
     wallet_id UUID NOT NULL CONSTRAINT wager_transactions_wallet_id_fkey REFERENCES wallets (id),
     player_id TEXT NOT NULL,
     round_id TEXT NOT NULL,
     game_id TEXT NOT NULL,
     kind TEXT NOT NULL CONSTRAINT wager_transactions_kind_valid CHECK (kind IN (${KINDS})),
     amount money_amount NOT NULL,
     currency currency_code NOT NULL,
     reference_external_transaction_id TEXT,
     status TEXT NOT NULL CONSTRAINT wager_transactions_status_valid CHECK (status IN (${STATUSES})),
     reference_transaction_id UUID
       CONSTRAINT wager_transactions_reference_transaction_id_fkey REFERENCES wager_transactions (id),
     failure_code TEXT
       CONSTRAINT wager_transactions_failure_code_valid CHECK (failure_code IN (${FAILURE_CODES})),
     resulting_balance money_amount,
     resulting_balance_currency currency_code,
     completed_at TIMESTAMPTZ,
     reference_attempts INTEGER NOT NULL DEFAULT 0
       CONSTRAINT wager_transactions_reference_attempts_non_negative CHECK (reference_attempts >= 0),
     next_reference_attempt_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL,

     CONSTRAINT wager_transactions_idempotency_key_key UNIQUE (idempotency_key),
     CONSTRAINT wager_transactions_provider_external_key UNIQUE (provider_id, external_transaction_id),

     CONSTRAINT wager_transactions_reversal_requires_reference
       CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
     CONSTRAINT wager_transactions_reference_not_allowed
       CHECK (kind NOT IN ('BET', 'OPENING') OR reference_external_transaction_id IS NULL),
     CONSTRAINT wager_transactions_no_self_reference
       CHECK (reference_external_transaction_id IS DISTINCT FROM external_transaction_id),
     CONSTRAINT wager_transactions_internal_provider
       CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
     CONSTRAINT wager_transactions_positive_amount CHECK (kind = 'LOSS' OR amount > 0),

     CONSTRAINT wager_transactions_failure_code_matches_status
       CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
     CONSTRAINT wager_transactions_completed_at_matches_status
       CHECK ((status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (completed_at IS NOT NULL)),
     CONSTRAINT wager_transactions_resulting_balance_pair
       CHECK ((resulting_balance IS NULL) = (resulting_balance_currency IS NULL)),
     CONSTRAINT wager_transactions_outcome_has_balance
       CHECK (status NOT IN ('PROCESSED', 'REJECTED', 'PENDING_REFERENCE') OR resulting_balance IS NOT NULL),
     CONSTRAINT wager_transactions_processed_reference_resolved
       CHECK (status <> 'PROCESSED' OR reference_external_transaction_id IS NULL
              OR reference_transaction_id IS NOT NULL)
   )`,

  // One effective reversal per reference, whatever its kind (stricter than §7 rule 4, ADR-0006).
  `CREATE UNIQUE INDEX wager_transactions_single_reversal_idx ON wager_transactions (reference_transaction_id)
     WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`,

  `CREATE INDEX wager_transactions_wallet_idx ON wager_transactions (wallet_id)`,

  // Retry worker: due pending references, and the "nudge" when a reference arrives (ADR-0012).
  `CREATE INDEX wager_transactions_pending_reference_due_idx ON wager_transactions (next_reference_attempt_at)
     WHERE status = 'PENDING_REFERENCE'`,
  `CREATE INDEX wager_transactions_waiting_on_reference_idx
     ON wager_transactions (provider_id, reference_external_transaction_id)
     WHERE status = 'PENDING_REFERENCE'`,

  `CREATE FUNCTION wager_transactions_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
       RAISE EXCEPTION 'transaction %: % is terminal and cannot change', OLD.id, OLD.status
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_transactions_terminal_immutable',
               TABLE = 'wager_transactions';
     END IF;

     IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
         NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
         NEW.reference_external_transaction_id, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
         OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
         OLD.reference_external_transaction_id, OLD.created_at) THEN
       RAISE EXCEPTION 'transaction %: business columns are immutable', OLD.id
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_transactions_immutable_columns',
               TABLE = 'wager_transactions';
     END IF;

     IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
          (OLD.status = 'PENDING'
            AND NEW.status IN ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))
       OR (OLD.status = 'PENDING_REFERENCE' AND NEW.status IN ('PROCESSED', 'REJECTED', 'FAILED'))) THEN
       RAISE EXCEPTION 'transaction %: transition % -> % is not allowed', OLD.id, OLD.status, NEW.status
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_transactions_transition',
               TABLE = 'wager_transactions';
     END IF;

     RETURN NEW;
   END $$`,

  `CREATE TRIGGER wager_transactions_guard_update BEFORE UPDATE ON wager_transactions
     FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard_update()`,

  `CREATE TRIGGER wager_transactions_no_delete BEFORE DELETE ON wager_transactions
     FOR EACH ROW EXECUTE FUNCTION forbid_change('wager_transactions_no_delete')`,

  `CREATE TRIGGER wager_transactions_no_truncate BEFORE TRUNCATE ON wager_transactions
     FOR EACH STATEMENT EXECUTE FUNCTION forbid_change('wager_transactions_no_delete')`,

  `GRANT SELECT, INSERT, UPDATE ON wager_transactions TO wagering_app`,
];

const DOWN = [`DROP TABLE wager_transactions`, `DROP FUNCTION wager_transactions_guard_update()`];

export class Migration20261113000200_wager_transactions extends Migration {
  override up(): void {
    for (const statement of UP) this.addSql(statement);
  }

  override down(): void {
    for (const statement of DOWN) this.addSql(statement);
  }
}
