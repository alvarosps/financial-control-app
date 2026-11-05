import { describe, expect, it } from 'vitest';
import { selectPayoffQuote } from './payoff-quote.ts';

describe('selectPayoffQuote', () => {
  const quote = {
    amount: '180.00',
    quotedOn: '2026-09-20',
    validUntil: '2026-10-05',
    source: 'Bank quote',
  };
  it('uses an explicit valid quote separately from the estimate', () => {
    expect(selectPayoffQuote('200.00', quote, '2026-10-01')).toMatchObject({
      estimatedAmount: '200.00',
      quotedAmount: '180.00',
      selectedAmount: '180.00',
      basis: 'quote',
      status: 'valid',
      difference: '-20.00',
    });
  });
  it('does not reuse expired/future quotes or pretend a missing quote is contractual', () => {
    expect(selectPayoffQuote('200.00', quote, '2026-10-06')).toMatchObject({
      selectedAmount: '200.00',
      basis: 'estimate',
      status: 'expired',
    });
    expect(selectPayoffQuote('200.00', quote, '2026-09-19').status).toBe('future');
    expect(selectPayoffQuote('100.00', null, '2026-09-28')).toMatchObject({
      quotedAmount: null,
      status: 'missing',
      selectedAmount: '100.00',
    });
  });
});
