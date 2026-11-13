# Data model

Source of truth: `src/infrastructure/database/migrations/`. Guarantees: ADR-0006.

```mermaid
erDiagram
  wallets ||--o{ wager_transactions : "wallet_id"
  wallets ||--o{ wallet_ledger_entries : "wallet_id"
  wager_transactions ||--o| wallet_ledger_entries : "transaction_id (at most one per wallet)"
  wager_transactions |o--o{ wager_transactions : "reference_transaction_id"

  wallets {
    uuid id PK
    text player_id "UNIQUE with currency"
    currency_code currency
    money_amount balance ">= 0, scale <= 2"
    int version ">= 1, +1 per balance change"
    timestamptz created_at
    timestamptz updated_at
  }

  wager_transactions {
    uuid id PK
    text provider_id "UNIQUE with external_transaction_id"
    text external_transaction_id
    text idempotency_key UK
    text payload_hash "sha-256 hex"
    uuid wallet_id FK
    text player_id
    text round_id
    text game_id
    text kind "OPENING BET WIN LOSS REFUND ROLLBACK"
    money_amount amount
    currency_code currency
    text reference_external_transaction_id "required for REFUND and ROLLBACK"
    text status "state machine guarded by trigger"
    uuid reference_transaction_id FK "single processed reversal"
    text failure_code "iff REJECTED or FAILED"
    money_amount resulting_balance "replay snapshot"
    currency_code resulting_balance_currency
    timestamptz completed_at "iff terminal"
    int reference_attempts "retry worker"
    timestamptz next_reference_attempt_at
    timestamptz created_at
    timestamptz updated_at
  }

  wallet_ledger_entries {
    uuid id PK
    uuid wallet_id FK
    uuid transaction_id FK
    text direction "DEBIT or CREDIT"
    money_amount amount "> 0"
    currency_code currency "= wallet currency"
    money_amount balance_before "= previous balance_after"
    money_amount balance_after "= before +- amount"
    int wallet_version "UNIQUE per wallet, gap-free"
    timestamptz created_at
  }

  inbox_messages {
    text consumer_name PK
    text message_id PK
    text payload_hash
    timestamptz received_at
    timestamptz processed_at
  }

  outbox_messages {
    uuid id PK "eventId"
    text aggregate_id
    text event_type
    jsonb payload "serialized envelope"
    timestamptz occurred_at
    int attempts ">= 0"
    timestamptz next_attempt_at "partial index while unpublished"
    timestamptz published_at
    text last_error
  }
```

## How balance and ledger stay locked together

```mermaid
flowchart LR
  subgraph tx["One SQL transaction (application)"]
    a["INSERT wager_transactions"] --> b["INSERT wallet_ledger_entries<br/>(version n+1, before = balance n)"]
    b --> c["UPDATE wallets<br/>balance, version = n+1"]
  end
  b -. "BEFORE INSERT<br/>wallet_ledger_entries_chain" .-> chk1{"continues version n<br/>and balance n?"}
  c -. "BEFORE UPDATE<br/>wallets_version_tracks_balance" .-> chk2{"version +1 iff<br/>balance changed?"}
  tx -. "at COMMIT<br/>wallets_balance_matches_ledger" .-> chk3{"balance = entry<br/>of its version?"}
```

## Indexes beyond primary keys and uniques

| Index                                          | Purpose                                                    |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `wager_transactions_single_reversal_idx`       | Unique: one processed REFUND/ROLLBACK per reference        |
| `wager_transactions_wallet_idx`                | Foreign-key checks and per-wallet queries                  |
| `wager_transactions_pending_reference_due_idx` | Retry worker: due `PENDING_REFERENCE` rows                 |
| `wager_transactions_waiting_on_reference_idx`  | Nudge dependents when their reference arrives              |
| `wallet_ledger_entries_wallet_version_key`     | Unique chain key; also the stable ledger pagination cursor |
| `outbox_messages_due_idx`                      | Relay claims: unpublished rows by `next_attempt_at`        |

## Roles

| Role                | Privileges                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `wagering_migrator` | Owns the schema; runs migrations; `CREATEDB` for test databases                                                     |
| `wagering_app`      | `SELECT, INSERT, UPDATE` on wallets, transactions, inbox, outbox; ledger `SELECT, INSERT` only; no DDL, no `DELETE` |
