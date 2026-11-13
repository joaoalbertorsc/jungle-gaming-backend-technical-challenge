# ADR-0013: Ledger pagination and reconciliation

- Status: Accepted
- Date: 2026-11-12

## Context

`GET /wallets/:walletId/ledger` needs a stable, opaque cursor (§9). `POST /wallets/:walletId/reconciliation`
compares the stored balance with the balance rebuilt from the ledger. Divergences are never corrected
silently: they are logged, counted in a metric and flagged in the response.

## Decision

**Ledger pagination.**

- Keyset on `(created_at, id)`, or on the gap-free `wallet_version` if the version chain of ADR-0006 lands.
- The cursor is base64url-encoded JSON (`{ "v": 1, "after": ... }`): opaque to clients and versioned.
- `limit` defaults to 50, with a maximum of 200.
- Keyset paging stays stable while new entries are appended, unlike offset paging.

**Reconciliation.**

- Runs in a read-only `REPEATABLE READ` transaction, so the wallet row and the ledger come from one consistent
  snapshot.
- It computes `calculatedBalance = Σ credits − Σ debits` and `checkedEntries`, then compares with
  `storedBalance`.
- A mismatch produces:
  - an `error` log with the wallet and both values;
  - an increment of `reconciliation_mismatches_total`;
  - `consistent: false` in the response.
- It **never** writes.

## Consequences

- Reconciliation can run at any time, even under load, without blocking writers.
- Every concurrency test ends with the same check, through a shared helper (ADR-0017).

## Alternatives considered

- **Offset pagination.** Unstable while entries are appended.
- **Auto-correcting divergences.** Explicitly disallowed (§9).
