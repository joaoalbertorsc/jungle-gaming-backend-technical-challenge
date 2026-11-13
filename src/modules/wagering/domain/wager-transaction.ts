import type { Money } from '../../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry';
import type { FailureCode } from './failure-code';
import { computePayloadHash, type WagerPayload } from './wager-payload';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './wagering-errors';

/** Provider id reserved for internal transactions (OPENING); external submissions cannot use it. */
export const INTERNAL_PROVIDER_ID = 'internal';

export enum WagerTransactionKind {
  /** Internal: opening credit of a wallet. Never submitted through the API or the queue. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Accepted, not applied yet. */
  Pending = 'PENDING',
  /** Waiting for the referenced transaction to arrive. */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied. Terminal. */
  Processed = 'PROCESSED',
  /** Business-rule violation. Terminal. */
  Rejected = 'REJECTED',
  /** Permanent infrastructure error. Terminal, kept for audit. */
  Failed = 'FAILED',
}

const Kind = WagerTransactionKind;
const Status = WagerTransactionStatus;

const SUBMITTABLE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  Kind.Bet,
  Kind.Win,
  Kind.Loss,
  Kind.Refund,
  Kind.Rollback,
]);
const KINDS_REQUIRING_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set([
  Kind.Refund,
  Kind.Rollback,
]);
const KINDS_ALLOWING_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set([
  Kind.Win,
  Kind.Loss,
  Kind.Refund,
  Kind.Rollback,
]);
const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  Status.Processed,
  Status.Rejected,
  Status.Failed,
]);
const UNDECIDED: readonly WagerTransactionStatus[] = [Status.Pending, Status.PendingReference];

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** Provider-side id of the referenced transaction (not the internal id). */
  readonly referenceExternalTransactionId?: string | undefined;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly payloadHash: string;
  readonly status: WagerTransactionStatus;
  /** Internal id of the resolved reference. */
  readonly referenceTransactionId?: string | undefined;
  readonly failureCode?: FailureCode | undefined;
  /** Balance observed when the outcome was decided; replays return it (§7 rule 7). */
  readonly resultingBalance?: Money | undefined;
  /** When the transaction reached a terminal state. */
  readonly completedAt?: Date | undefined;
}

/**
 * A provider operation on a wallet (§6.3).
 *
 * Valid transitions:
 *
 *   PENDING ──► PROCESSED | REJECTED | FAILED
 *   PENDING ──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
 *
 * PROCESSED, REJECTED and FAILED are terminal: any further transition is a programming error.
 */
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _resultingBalance: Money | undefined;
  private _completedAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = new Date(state.createdAt.getTime());
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._resultingBalance = state.resultingBalance;
    this._completedAt = copyDate(state.completedAt);
  }

  /** A submitted transaction. Starts PENDING; validates the reference requirements per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    assertCreatable(props);
    return new WagerTransaction({
      ...props,
      payloadHash: computePayloadHash(payloadOf(props)),
      status: Status.Pending,
    });
  }

  /** The internal OPENING credit of a new wallet, applied in the same SQL transaction. */
  static opening(props: {
    readonly id: string;
    readonly walletId: string;
    readonly playerId: string;
    readonly money: Money;
    readonly at: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('AMOUNT_MUST_BE_POSITIVE', 'opening amount');
    }
    const base: CreateWagerTransactionProps = {
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: Kind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.at,
    };
    return new WagerTransaction({
      ...base,
      payloadHash: computePayloadHash(payloadOf(base)),
      status: Status.Processed,
      resultingBalance: props.money,
      completedAt: props.at,
    });
  }

  /** Reconstruction from persistence: no validation of creation rules or transitions (§6.0). */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }

  get completedAt(): Date | undefined {
    return copyDate(this._completedAt);
  }

  get processedAt(): Date | undefined {
    return this._status === Status.Processed ? this.completedAt : undefined;
  }

  // ---- transitions

  markProcessed(props: {
    readonly referenceTransactionId: string | undefined;
    readonly resultingBalance: Money;
    readonly at: Date;
  }): void {
    this.assertTransition(UNDECIDED, 'markProcessed');
    this._status = Status.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._resultingBalance = props.resultingBalance;
    this._completedAt = copyDate(props.at);
  }

  markPendingReference(props: { readonly observedBalance: Money }): void {
    this.assertTransition([Status.Pending], 'markPendingReference');
    this._status = Status.PendingReference;
    this._resultingBalance = props.observedBalance;
  }

  reject(props: {
    readonly failureCode: FailureCode;
    readonly resultingBalance: Money;
    readonly at: Date;
  }): void {
    this.assertTransition(UNDECIDED, 'reject');
    this._status = Status.Rejected;
    this._failureCode = props.failureCode;
    this._resultingBalance = props.resultingBalance;
    this._completedAt = copyDate(props.at);
  }

  fail(props: { readonly failureCode: FailureCode; readonly at: Date }): void {
    this.assertTransition(UNDECIDED, 'fail');
    this._status = Status.Failed;
    this._failureCode = props.failureCode;
    this._completedAt = copyDate(props.at);
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** False for LOSS, which records a result without moving money. */
  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Ledger direction of this transaction; a ROLLBACK is the inverse of its reference. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Win:
      case Kind.Refund:
      case Kind.Opening:
        return LedgerDirection.Credit;
      case Kind.Loss:
        throw new InvalidTransactionStateError(this.id, 'LOSS has no ledger effect');
      case Kind.Rollback: {
        if (reference === undefined || !reference.affectsBalance()) {
          throw new InvalidTransactionStateError(
            this.id,
            'ROLLBACK needs a balance-moving reference',
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  payload(): WagerPayload {
    return payloadOf(this);
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: new Date(this.createdAt.getTime()),
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      resultingBalance: this._resultingBalance,
      completedAt: this.completedAt,
    };
  }

  private assertTransition(
    allowedFrom: readonly WagerTransactionStatus[],
    transition: string,
  ): void {
    if (!allowedFrom.includes(this._status)) {
      throw new InvalidTransactionStateError(
        this.id,
        `${transition} is not allowed from ${this._status}`,
      );
    }
  }
}

function payloadOf(props: CreateWagerTransactionProps): WagerPayload {
  return {
    providerId: props.providerId,
    externalTransactionId: props.externalTransactionId,
    playerId: props.playerId,
    walletId: props.walletId,
    roundId: props.roundId,
    gameId: props.gameId,
    kind: props.kind,
    money: props.money.toJSON(),
    referenceExternalTransactionId: props.referenceExternalTransactionId,
  };
}

const REQUIRED_TEXT_FIELDS = [
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'walletId',
  'playerId',
  'roundId',
  'gameId',
] as const;

function assertCreatable(props: CreateWagerTransactionProps): void {
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (props[field].trim() === '') {
      throw new InvalidWagerTransactionError('MISSING_FIELD', `${field} is required`);
    }
  }

  if (props.kind === Kind.Opening) {
    throw new InvalidWagerTransactionError('OPENING_NOT_SUBMITTABLE', 'OPENING is internal');
  }
  if (!SUBMITTABLE_KINDS.has(props.kind)) {
    throw new InvalidWagerTransactionError('UNKNOWN_KIND', `unknown kind ${props.kind}`);
  }
  if (props.providerId === INTERNAL_PROVIDER_ID) {
    throw new InvalidWagerTransactionError('RESERVED_PROVIDER', 'provider id is reserved');
  }

  const reference = props.referenceExternalTransactionId;
  if (reference === undefined || reference.trim() === '') {
    if (KINDS_REQUIRING_REFERENCE.has(props.kind)) {
      throw new InvalidWagerTransactionError(
        'REFERENCE_REQUIRED',
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (reference !== undefined) {
      throw new InvalidWagerTransactionError('MISSING_FIELD', 'reference cannot be blank');
    }
  } else {
    if (!KINDS_ALLOWING_REFERENCE.has(props.kind)) {
      throw new InvalidWagerTransactionError(
        'REFERENCE_NOT_ALLOWED',
        `${props.kind} cannot reference another transaction`,
      );
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError(
        'SELF_REFERENCE',
        'a transaction cannot reference itself',
      );
    }
  }

  const amountValid =
    props.kind === Kind.Loss ? !props.money.isNegative() : props.money.isPositive();
  if (!amountValid) {
    throw new InvalidWagerTransactionError(
      'AMOUNT_MUST_BE_POSITIVE',
      `${props.kind} requires a positive amount`,
    );
  }
}

function copyDate(date: Date | undefined): Date | undefined {
  return date === undefined ? undefined : new Date(date.getTime());
}
