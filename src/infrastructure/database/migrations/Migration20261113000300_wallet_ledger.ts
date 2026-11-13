import { Migration } from '@mikro-orm/migrations';

/**
 * The append-only ledger and the version chain that ties it to wallet balances (ADR-0006).
 *
 * Together, the chain trigger (each entry continues the previous one) and the deferred wallet check
 * (each balance equals the entry of its version) make "balance == ledger replay" a database invariant.
 */
const UP = [
  `CREATE TABLE wallet_ledger_entries (
     id UUID PRIMARY KEY,
     wallet_id UUID NOT NULL CONSTRAINT wallet_ledger_entries_wallet_id_fkey REFERENCES wallets (id),
     transaction_id UUID NOT NULL
       CONSTRAINT wallet_ledger_entries_transaction_id_fkey REFERENCES wager_transactions (id),
     direction TEXT NOT NULL
       CONSTRAINT wallet_ledger_entries_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
     amount money_amount NOT NULL CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
     currency currency_code NOT NULL,
     balance_before money_amount NOT NULL,
     balance_after money_amount NOT NULL,
     wallet_version INTEGER NOT NULL
       CONSTRAINT wallet_ledger_entries_wallet_version_positive CHECK (wallet_version >= 1),
     created_at TIMESTAMPTZ NOT NULL,

     CONSTRAINT wallet_ledger_entries_balanced CHECK (
       balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount
                                      ELSE balance_before - amount END),
     CONSTRAINT wallet_ledger_entries_transaction_wallet_key UNIQUE (transaction_id, wallet_id),
     CONSTRAINT wallet_ledger_entries_wallet_version_key UNIQUE (wallet_id, wallet_version)
   )`,

  `CREATE FUNCTION wallet_ledger_entries_check_chain() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     wallet_currency TEXT;
     previous RECORD;
   BEGIN
     SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id;
     IF FOUND AND wallet_currency <> NEW.currency THEN
       RAISE EXCEPTION 'ledger entry %: currency % differs from wallet currency %',
         NEW.id, NEW.currency, wallet_currency
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_currency',
               TABLE = 'wallet_ledger_entries';
     END IF;

     SELECT wallet_version, balance_after INTO previous
       FROM wallet_ledger_entries
      WHERE wallet_id = NEW.wallet_id
      ORDER BY wallet_version DESC
      LIMIT 1;

     IF FOUND THEN
       IF NEW.wallet_version <> previous.wallet_version + 1
          OR NEW.balance_before <> previous.balance_after THEN
         RAISE EXCEPTION 'ledger entry %: must continue version % with balance %',
           NEW.id, previous.wallet_version, previous.balance_after
           USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_chain',
                 TABLE = 'wallet_ledger_entries';
       END IF;
     -- First entry: the OPENING credit (version 1) or, for a wallet opened at zero, its first movement.
     ELSIF NEW.balance_before <> 0 OR NEW.wallet_version NOT IN (1, 2) THEN
       RAISE EXCEPTION 'ledger entry %: the first entry must start from a zero balance', NEW.id
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_chain',
               TABLE = 'wallet_ledger_entries';
     END IF;

     RETURN NEW;
   END $$`,

  `CREATE TRIGGER wallet_ledger_entries_check_chain BEFORE INSERT ON wallet_ledger_entries
     FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_check_chain()`,

  // Append-only: no UPDATE, DELETE or TRUNCATE, even for the schema owner (§5.5).
  `CREATE TRIGGER wallet_ledger_entries_append_only BEFORE UPDATE OR DELETE ON wallet_ledger_entries
     FOR EACH ROW EXECUTE FUNCTION forbid_change('wallet_ledger_entries_append_only')`,
  `CREATE TRIGGER wallet_ledger_entries_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
     FOR EACH STATEMENT EXECUTE FUNCTION forbid_change('wallet_ledger_entries_append_only')`,

  // Checked at commit, once the whole financial transaction is written.
  `CREATE FUNCTION wallets_check_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     entry_balance NUMERIC;
   BEGIN
     SELECT balance_after INTO entry_balance
       FROM wallet_ledger_entries
      WHERE wallet_id = NEW.id AND wallet_version = NEW.version;

     IF FOUND THEN
       IF entry_balance <> NEW.balance THEN
         RAISE EXCEPTION 'wallet %: balance % differs from ledger balance % at version %',
           NEW.id, NEW.balance, entry_balance, NEW.version
           USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_balance_matches_ledger',
                 TABLE = 'wallets';
       END IF;
     ELSIF NOT (NEW.version = 1 AND NEW.balance = 0) THEN
       RAISE EXCEPTION 'wallet %: no ledger entry for version % (balance %)',
         NEW.id, NEW.version, NEW.balance
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_balance_matches_ledger',
               TABLE = 'wallets';
     END IF;

     RETURN NULL;
   END $$`,

  `CREATE CONSTRAINT TRIGGER wallets_balance_matches_ledger AFTER INSERT OR UPDATE ON wallets
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION wallets_check_ledger()`,

  // Runtime role: append only.
  `GRANT SELECT, INSERT ON wallet_ledger_entries TO wagering_app`,
];

const DOWN = [
  `DROP TRIGGER wallets_balance_matches_ledger ON wallets`,
  `DROP FUNCTION wallets_check_ledger()`,
  `DROP TABLE wallet_ledger_entries`,
  `DROP FUNCTION wallet_ledger_entries_check_chain()`,
];

export class Migration20261113000300_wallet_ledger extends Migration {
  override up(): void {
    for (const statement of UP) this.addSql(statement);
  }

  override down(): void {
    for (const statement of DOWN) this.addSql(statement);
  }
}
