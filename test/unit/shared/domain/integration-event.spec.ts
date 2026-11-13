import { describe, expect, it } from 'bun:test';
import {
  type EventContext,
  IntegrationEvent,
} from '../../../../src/shared/domain/integration-event';

interface SampleData {
  readonly value: string;
  readonly nested: { readonly amount: string };
}

class SampleHappened extends IntegrationEvent<SampleData> {
  readonly eventType = 'SampleHappened';
  readonly version = 3;

  static of(aggregateId: string, data: SampleData, context: EventContext): SampleHappened {
    return new SampleHappened({ ...context, aggregateId, data });
  }
}

const context: EventContext = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: new Date('2026-07-29T15:00:00.000Z'),
};

describe('IntegrationEvent', () => {
  it('serializes the envelope with type and version taken from the subclass', () => {
    const event = SampleHappened.of('agg-1', { value: 'x', nested: { amount: '1.00' } }, context);

    expect(event.toJSON()).toEqual({
      eventId: 'event-1',
      eventType: 'SampleHappened',
      aggregateId: 'agg-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 3,
      data: { value: 'x', nested: { amount: '1.00' } },
    });
  });

  it('omits causationId when the event has no cause', () => {
    const event = SampleHappened.of(
      'agg-1',
      { value: 'x', nested: { amount: '1.00' } },
      { ...context, causationId: undefined },
    );

    expect('causationId' in event.toJSON()).toBe(false);
  });

  it('is stable JSON: serializing and parsing yields the same envelope', () => {
    const event = SampleHappened.of('agg-1', { value: 'x', nested: { amount: '1.00' } }, context);

    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  it('freezes its data so a published payload cannot be altered', () => {
    const data = { value: 'x', nested: { amount: '1.00' } };
    const event = SampleHappened.of('agg-1', data, context);

    expect(() => {
      (event.data.nested as { amount: string }).amount = '2.00';
    }).toThrow(TypeError);
    data.nested.amount = '9.99';
    expect(event.data.nested.amount).toBe('1.00');
  });
});
