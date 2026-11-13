import { DomainError } from '../../../shared/domain/errors';

/** An inbox or outbox transition attempted from a state that forbids it (programming error). */
export class InvalidMessageStateError extends DomainError {
  readonly code = 'INVALID_MESSAGE_STATE';

  constructor(messageId: string, detail: string) {
    super(`Message ${messageId}: ${detail}`);
  }
}
