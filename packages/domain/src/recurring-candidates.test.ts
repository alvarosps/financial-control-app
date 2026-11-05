import { describe, expect, it } from 'vitest';
import { type RecurringEvidence, recurringCandidates } from './recurring-candidates.ts';

const sample = (
  id: string,
  date: string,
  amount = '50.00',
  extra: Partial<RecurringEvidence> = {},
): RecurringEvidence => ({
  id,
  date,
  amount,
  currency: 'BRL',
  description: 'Stream contrato 123',
  cardAccountId: 'card',
  actual: true,
  ...extra,
});
describe('recurringCandidates', () => {
  it('requires three past monthly observations and explains a price change with explicit tolerances', () => {
    expect(
      recurringCandidates(
        [sample('1', '2026-07-05'), sample('2', '2026-08-05'), sample('3', '2026-09-05', '60.00')],
        '2026-09-28',
      ),
    ).toMatchObject([
      {
        merchant: 'stream contrato 123',
        count: 3,
        intervalMinDays: 25,
        intervalMaxDays: 35,
        previousAmount: '50.00',
        latestAmount: '60.00',
        priceChanged: true,
        requiresReview: true,
      },
    ]);
  });
  it('does not turn future materializations, duplicate same-day evidence or near names/contracts into recurrence', () => {
    const rows = [
      sample('1', '2026-07-05'),
      sample('2', '2026-08-05'),
      sample('3', '2026-09-05', '50.00', { actual: false }),
      sample('4', '2026-10-05'),
      sample('5', '2026-08-05'),
      sample('6', '2026-09-05', '50.00', { description: 'Stream contrato 124' }),
      sample('7', '2026-09-05', '50.00', { cardAccountId: 'other' }),
    ];
    expect(recurringCandidates(rows, '2026-09-28')).toEqual([]);
  });
  it('rejects irregular intervals, unstable earlier prices and marketplace ambiguity', () => {
    expect(
      recurringCandidates(
        [
          sample('1', '2026-07-05'),
          sample('2', '2026-08-05', '90.00'),
          sample('3', '2026-09-05', '120.00'),
        ],
        '2026-09-28',
      ),
    ).toEqual([]);
    expect(
      recurringCandidates(
        ['2026-07-05', '2026-07-08', '2026-08-01'].map((date, i) => sample(String(i), date)),
        '2026-09-28',
      ),
    ).toEqual([]);
    expect(
      recurringCandidates(
        ['2026-07-05', '2026-08-05', '2026-09-05'].map((date, i) =>
          sample(String(i), date, '50.00', { description: 'Amazon marketplace' }),
        ),
        '2026-09-28',
      ),
    ).toEqual([]);
  });
});
