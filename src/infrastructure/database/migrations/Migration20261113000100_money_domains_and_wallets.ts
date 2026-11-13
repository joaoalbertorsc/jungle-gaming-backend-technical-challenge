import { Migration } from '@mikro-orm/migrations';

/**
 * Money domains, the wallets table and its guards (ADR-0005, ADR-0006).
 *
 * money_amount is an unconstrained NUMERIC with checks instead of NUMERIC(19,2): a typmod would
 * silently round 1.005 to 1.01, while the domain rejects it, matching Money's "never round" rule.
 */
const UP = [
  `CREATE DOMAIN money_amount AS NUMERIC
     CONSTRAINT money_amount_non_negative CHECK (VALUE >= 0)
     CONSTRAINT money_amount_max_scale CHECK (scale(VALUE) <= 2)
     CONSTRAINT money_amount_max_precision CHECK (VALUE < 100000000000000000)`,

  `CREATE DOMAIN currency_code AS CHAR(3)
     CONSTRAINT currency_code_format CHECK (VALUE ~ '^[A-Z]{3}$')`,

  // Shared by every "this must never happen" trigger; the constraint name comes from TG_ARGV[0].
  `CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION '% on % is not allowed', TG_OP, TG_TABLE_NAME
       USING ERRCODE = 'check_violation', CONSTRAINT = TG_ARGV[0], TABLE = TG_TABLE_NAME;
   END $$`,

  `CREATE TABLE wallets (
     id UUID PRIMARY KEY,
     player_id TEXT NOT NULL
       CONSTRAINT wallets_player_id_not_blank CHECK (length(btrim(player_id)) > 0),
     currency currency_code NOT NULL,
     balance money_amount NOT NULL,
     version INTEGER NOT NULL CONSTRAINT wallets_version_positive CHECK (version >= 1),
     created_at TIMESTAMPTZ NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL,
     CONSTRAINT wallets_player_currency_key UNIQUE (player_id, currency)
   )`,

  `CREATE FUNCTION wallets_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
       RAISE EXCEPTION 'wallet %: identity columns are immutable', OLD.id
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_immutable_columns', TABLE = 'wallets';
     END IF;
     IF (NEW.balance <> OLD.balance OR NEW.version <> OLD.version)
        AND NOT (NEW.balance <> OLD.balance AND NEW.version = OLD.version + 1) THEN
       RAISE EXCEPTION 'wallet %: version must increase by exactly 1 with every balance change', OLD.id
         USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_version_tracks_balance',
               TABLE = 'wallets';
     END IF;
     RETURN NEW;
   END $$`,

  `CREATE TRIGGER wallets_guard_update BEFORE UPDATE ON wallets
     FOR EACH ROW EXECUTE FUNCTION wallets_guard_update()`,

  `CREATE TRIGGER wallets_no_delete BEFORE DELETE ON wallets
     FOR EACH ROW EXECUTE FUNCTION forbid_change('wallets_no_delete')`,

  `CREATE TRIGGER wallets_no_truncate BEFORE TRUNCATE ON wallets
     FOR EACH STATEMENT EXECUTE FUNCTION forbid_change('wallets_no_delete')`,

  // Runtime role: DML only, never DELETE (wallets are permanent).
  `GRANT SELECT, INSERT, UPDATE ON wallets TO wagering_app`,
];

const DOWN = [
  `DROP TABLE wallets`,
  `DROP FUNCTION wallets_guard_update()`,
  `DROP FUNCTION forbid_change()`,
  `DROP DOMAIN currency_code`,
  `DROP DOMAIN money_amount`,
];

export class Migration20261113000100_money_domains_and_wallets extends Migration {
  override up(): void {
    for (const statement of UP) this.addSql(statement);
  }

  override down(): void {
    for (const statement of DOWN) this.addSql(statement);
  }
}
