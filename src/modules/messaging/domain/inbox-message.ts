import { InvalidMessageStateError } from './messaging-errors';

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt?: Date | undefined;
}

/**
 * Persistent deduplication record for one consumed message, keyed by (consumerName, messageId)
 * and written in the same SQL transaction as its effects (ADR-0010).
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return InboxMessage.rehydrate({ ...props, processedAt: undefined });
  }

  /** Reconstruction from persistence: no validation (§6.0). */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt.getTime()),
      state.processedAt === undefined ? undefined : new Date(state.processedAt.getTime()),
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : new Date(this._processedAt.getTime());
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Same messageId with another payload is an anomaly, not a duplicate. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(this.messageId, 'already processed');
    }
    this._processedAt = new Date(at.getTime());
  }
}
