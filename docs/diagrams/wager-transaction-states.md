# Wager transaction lifecycle and rules

Why: §7 defines what each kind may do and in which order the rules apply. The state machine makes sure a
decided transaction never changes again.

Source: `src/modules/wagering/domain/wager-transaction.ts` and `wager-transaction-processor.ts`.

## State machine (§6.3)

```mermaid
stateDiagram-v2
  [*] --> PENDING: create()
  PENDING --> PROCESSED: markProcessed()
  PENDING --> REJECTED: reject(failureCode)
  PENDING --> FAILED: fail(failureCode)
  PENDING --> PENDING_REFERENCE: markPendingReference()<br/>reference not arrived yet
  PENDING_REFERENCE --> PROCESSED: reference arrived and rules pass
  PENDING_REFERENCE --> REJECTED: rule violated, or retries exhausted (REFERENCE_NOT_FOUND)
  PENDING_REFERENCE --> FAILED: permanent infrastructure error
  PROCESSED --> [*]
  REJECTED --> [*]
  FAILED --> [*]
```

- `PROCESSED`, `REJECTED` and `FAILED` are terminal. Any further transition throws
  `InvalidTransactionStateError`, because it is a programming error, not a business path.
- `OPENING` is created directly as `PROCESSED` by `WagerTransaction.opening()`, inside the same SQL
  transaction as the wallet. It is never submitted.
- Every decision stores the balance observed at that moment (`resultingBalance`), so a replay returns the
  original outcome (§7 rule 7).

## Decision order in the processor

```mermaid
flowchart TB
  start["PENDING or PENDING_REFERENCE<br/>wallet row locked"] --> owner{"wallet belongs<br/>to the player?"}
  owner -- no --> r1["REJECTED · WALLET_PLAYER_MISMATCH"]
  owner -- yes --> cur{"same currency<br/>as the wallet?"}
  cur -- no --> r2["REJECTED · CURRENCY_MISMATCH"]
  cur -- yes --> hasref{"has a reference?"}
  hasref -- no --> effect
  hasref -- yes --> found{"reference found?"}
  found -- no --> pend["PENDING_REFERENCE"]
  found -- yes --> ctx{"same provider, player,<br/>wallet, round, currency?"}
  ctx -- no --> r3["REJECTED · REFERENCE_MISMATCH"]
  ctx -- yes --> kind{"allowed kind?"}
  kind -- no --> r4["REJECTED · INVALID_REFERENCE_KIND"]
  kind -- yes --> status{"reference status"}
  status -- "PENDING / PENDING_REFERENCE" --> pend
  status -- "REJECTED / FAILED" --> r5["REJECTED · REFERENCE_NOT_PROCESSED"]
  status -- PROCESSED --> rev{"reversal?"}
  rev -- no --> effect
  rev -- yes --> once{"already reversed?"}
  once -- yes --> r6["REJECTED · ALREADY_REVERSED"]
  once -- no --> amt{"same amount?"}
  amt -- no --> r7["REJECTED · AMOUNT_MISMATCH"]
  amt -- yes --> effect
  effect{"movement"} -- "LOSS" --> done["PROCESSED, no ledger entry"]
  effect -- "credit" --> credit["PROCESSED + CREDIT entry"]
  effect -- "debit" --> funds{"balance ≥ amount?"}
  funds -- yes --> debit["PROCESSED + DEBIT entry"]
  funds -- "no (BET)" --> r8["REJECTED · INSUFFICIENT_FUNDS"]
  funds -- "no (ROLLBACK)" --> r9["REJECTED · REVERSAL_WOULD_OVERDRAW"]
```

## Rules per kind (§7)

| Kind     | Reference                            | Movement                                    | Ledger                     |
| -------- | ------------------------------------ | ------------------------------------------- | -------------------------- |
| BET      | Forbidden                            | Debit; `INSUFFICIENT_FUNDS` if not covered  | 1 `DEBIT`                  |
| WIN      | Optional, must be the round BET      | Credit                                      | 1 `CREDIT`                 |
| LOSS     | Optional, must be the round BET      | None (amount may be 0.00)                   | None                       |
| REFUND   | Required, a processed BET            | Credit of the same amount, once             | 1 `CREDIT`                 |
| ROLLBACK | Required, a processed BET/WIN/REFUND | Inverse of the reference, same amount, once | 1 entry, inverse direction |
| OPENING  | Internal only                        | Credit of the initial balance               | 1 `CREDIT`                 |
