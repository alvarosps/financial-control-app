import { describe, expect, it } from 'vitest';
import {
  assignBillingPeriod,
  assignOccurrenceBilling,
  computeFaturaDueDate,
  getBillingPeriodDateRange,
  resolveStatementCycle,
} from './billing-period.ts';

function dueDateParts(d: Date) {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

describe('resolveStatementCycle', () => {
  it('drops an estimated closing that conflicts with a confirmed due date', () => {
    expect(
      resolveStatementCycle({
        reference: 'closing',
        month: 9,
        year: 2026,
        dueDate: '2026-09-15',
        config: { closingDay: 20, dueDay: 25 },
      }),
    ).toMatchObject({
      billingMonth: 9,
      dueDate: '2026-09-15',
      dueDateSource: 'institution',
      closingDate: null,
      closingDateSource: 'unknown',
      confidence: 'unknown',
    });
  });
  it('estimates from the actual closing day after the card settings change', () => {
    expect(
      resolveStatementCycle({
        reference: 'closing',
        month: 8,
        year: 2026,
        closingDate: '2026-08-24',
        config: { closingDay: 3, dueDay: 15 },
      }),
    ).toMatchObject({
      dueDate: '2026-09-15',
      dueDateSource: 'configuration',
      confidence: 'estimated',
    });
  });
  it.each([
    { closing: '2026-08-24', due: '2026-09-08', month: 8, year: 2026 },
    { closing: '2026-09-15', due: '2026-09-25', month: 9, year: 2026 },
    { closing: '2026-12-24', due: '2027-01-08', month: 12, year: 2026 },
    { closing: '2028-02-29', due: '2028-03-08', month: 2, year: 2028 },
  ])('uses actual closing $closing and due $due over changed settings', (example) => {
    const [year, month] = example.due.split('-').map(Number);
    expect(
      resolveStatementCycle({
        reference: 'due',
        month,
        year,
        closingDate: example.closing,
        dueDate: example.due,
        config: { closingDay: 3, dueDay: 15 },
      }),
    ).toMatchObject({
      billingMonth: example.month,
      billingYear: example.year,
      closingDate: example.closing,
      dueDate: example.due,
      closingDateSource: 'institution',
      dueDateSource: 'institution',
      confidence: 'confirmed',
      reason: 'actual_dates',
    });
  });

  it('proposes an estimated closing cycle when only the due date is known', () => {
    expect(
      resolveStatementCycle({
        reference: 'due',
        month: 9,
        year: 2026,
        dueDate: '2026-09-08',
        config: { closingDay: 24, dueDay: 8 },
      }),
    ).toMatchObject({
      billingMonth: 8,
      billingYear: 2026,
      closingDate: '2026-08-24',
      dueDate: '2026-09-08',
      closingDateSource: 'configuration',
      dueDateSource: 'institution',
      confidence: 'estimated',
    });
  });

  it('keeps the same month when the due day is after closing', () => {
    expect(
      resolveStatementCycle({
        reference: 'due',
        month: 9,
        year: 2026,
        dueDate: '2026-09-25',
        config: { closingDay: 15, dueDay: 25 },
      }),
    ).toMatchObject({ billingMonth: 9, billingYear: 2026 });
  });

  it('clamps leap February and rolls a January due reference into December', () => {
    expect(
      resolveStatementCycle({
        reference: 'closing',
        month: 1,
        year: 2028,
        config: { closingDay: 31, dueDay: 31 },
      }),
    ).toMatchObject({ closingDate: '2028-01-31', dueDate: '2028-02-29', confidence: 'estimated' });
    expect(
      resolveStatementCycle({
        reference: 'due',
        month: 1,
        year: 2027,
        dueDate: '2027-01-08',
        config: { closingDay: 24, dueDay: 8 },
      }),
    ).toMatchObject({ billingMonth: 12, billingYear: 2026 });
  });

  it('represents unknown dates without fabricating the first day', () => {
    expect(resolveStatementCycle({ reference: 'closing', month: 8, year: 2026 })).toMatchObject({
      billingMonth: 8,
      billingYear: 2026,
      closingDate: null,
      dueDate: null,
      closingDateSource: 'unknown',
      dueDateSource: 'unknown',
      confidence: 'unknown',
    });
    expect(() => resolveStatementCycle({ reference: 'due', month: 9, year: 2026 })).toThrow(
      'statement.insufficientCycleData',
    );
  });

  it('preserves institution calendar days in America/Sao_Paulo', () => {
    const cycle = resolveStatementCycle({
      reference: 'closing',
      month: 8,
      year: 2026,
      closingDate: '2026-08-24',
      dueDate: '2026-09-08',
    });
    const saoPauloDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date('2026-09-08T03:00:00Z'));
    expect(cycle.dueDate).toBe(saoPauloDate);
  });

  it.each([
    {
      reference: 'closing' as const,
      month: 9,
      year: 2026,
      closingDate: '2026-08-24',
      dueDate: '2026-09-08',
    },
    {
      reference: 'due' as const,
      month: 8,
      year: 2026,
      closingDate: '2026-08-24',
      dueDate: '2026-09-08',
    },
    {
      reference: 'closing' as const,
      month: 8,
      year: 2026,
      closingDate: '2026-08-24',
      dueDate: '2026-08-08',
    },
  ])('rejects conflicting dates or reference %#', (input) => {
    expect(() => resolveStatementCycle(input)).toThrow('statement.cycleConflict');
  });

  it.each([
    '2026-02-29',
    '2026-04-31',
    '2026-09-08T00:00:00Z',
    '08/09/2026',
  ])('rejects invalid calendar date %s', (dueDate) => {
    expect(() =>
      resolveStatementCycle({ reference: 'closing', month: 8, year: 2026, dueDate }),
    ).toThrow('statement.invalidDate');
  });
});

describe('assignBillingPeriod', () => {
  it('purchase on day 1 (before closing) → current month bill', () => {
    const result = assignBillingPeriod(new Date(2026, 2, 1), 3);
    expect(result).toEqual({ billingMonth: 3, billingYear: 2026 });
  });

  it('purchase on day 3 (on closing) → current month bill', () => {
    const result = assignBillingPeriod(new Date(2026, 2, 3), 3);
    expect(result).toEqual({ billingMonth: 3, billingYear: 2026 });
  });

  it('purchase on day 5 (after closing) → next month bill', () => {
    const result = assignBillingPeriod(new Date(2026, 2, 5), 3);
    expect(result).toEqual({ billingMonth: 4, billingYear: 2026 });
  });

  it('purchase on day 15 of december after closing → january next year', () => {
    const result = assignBillingPeriod(new Date(2026, 11, 15), 10);
    expect(result).toEqual({ billingMonth: 1, billingYear: 2027 });
  });

  it('purchase on day 5 of december before closing day 10 → december bill', () => {
    const result = assignBillingPeriod(new Date(2026, 11, 5), 10);
    expect(result).toEqual({ billingMonth: 12, billingYear: 2026 });
  });
});

describe('getBillingPeriodDateRange', () => {
  it('march bill with closing day 3: Feb 4 to Mar 3', () => {
    const result = getBillingPeriodDateRange(3, 2026, 3);
    expect(result.start).toEqual(new Date(2026, 1, 4));
    expect(result.end).toEqual(new Date(2026, 2, 3));
  });

  it('january bill with closing day 10: Dec 11 prev year to Jan 10', () => {
    const result = getBillingPeriodDateRange(1, 2026, 10);
    expect(result.start).toEqual(new Date(2025, 11, 11));
    expect(result.end).toEqual(new Date(2026, 0, 10));
  });

  it('best shopping day is day after closing', () => {
    const result = getBillingPeriodDateRange(4, 2026, 3);
    expect(result.bestShoppingDay).toEqual(new Date(2026, 2, 4));
  });

  it('handles closingDay 31 in February (clamps to 28)', () => {
    const result = getBillingPeriodDateRange(2, 2026, 31);
    // Feb 2026 has 28 days, so closing day should be Feb 28
    expect(result.end).toEqual(new Date(2026, 1, 28));
    // Start should be day after Jan 31 = Feb 1
    expect(result.start).toEqual(new Date(2026, 1, 1));
  });

  it('handles closingDay 31 in April (clamps to 30)', () => {
    const result = getBillingPeriodDateRange(4, 2026, 31);
    expect(result.end).toEqual(new Date(2026, 3, 30));
  });
});

describe('assignOccurrenceBilling', () => {
  it('credit-card installment uses index-based billing, NOT the occurrence date', () => {
    // Card closingDay=3, dueDay=10. Installment 5/10, firstBilling = Dec 2025.
    // The occurrence date carries the due day (Apr 10) — date-based assignment
    // (day 10 > closing 3) would wrongly bump it to May. Index-based must give April.
    const result = assignOccurrenceBilling({
      isCreditCard: true,
      totalOccurrences: 10,
      firstBillingMonth: 12,
      firstBillingYear: 2025,
      occurrenceNumber: 5,
      date: new Date(2026, 3, 10), // Apr 10 (due day, after closing day 3)
      closingDay: 3,
    });
    expect(result).toEqual({ billingMonth: 4, billingYear: 2026 });
  });

  it('index-based billing rolls across a year boundary', () => {
    // firstBilling Nov 2025, occurrence 3 → Jan 2026.
    const result = assignOccurrenceBilling({
      isCreditCard: true,
      totalOccurrences: 6,
      firstBillingMonth: 11,
      firstBillingYear: 2025,
      occurrenceNumber: 3,
      date: new Date(2026, 0, 10),
      closingDay: 3,
    });
    expect(result).toEqual({ billingMonth: 1, billingYear: 2026 });
  });

  it('non-installment credit-card charge falls back to date-based assignment', () => {
    const result = assignOccurrenceBilling({
      isCreditCard: true,
      totalOccurrences: null,
      firstBillingMonth: null,
      firstBillingYear: null,
      occurrenceNumber: 1,
      date: new Date(2026, 2, 5), // day 5 > closing 3 → next month
      closingDay: 3,
    });
    expect(result).toEqual({ billingMonth: 4, billingYear: 2026 });
  });

  it('installment without firstBilling falls back to date-based assignment', () => {
    const result = assignOccurrenceBilling({
      isCreditCard: true,
      totalOccurrences: 10,
      firstBillingMonth: null,
      firstBillingYear: null,
      occurrenceNumber: 5,
      date: new Date(2026, 2, 1), // day 1 ≤ closing 3 → current month
      closingDay: 3,
    });
    expect(result).toEqual({ billingMonth: 3, billingYear: 2026 });
  });

  it('non-credit-card destination has no billing period', () => {
    const result = assignOccurrenceBilling({
      isCreditCard: false,
      totalOccurrences: 10,
      firstBillingMonth: 12,
      firstBillingYear: 2025,
      occurrenceNumber: 5,
      date: new Date(2026, 3, 10),
      closingDay: null,
    });
    expect(result).toBeNull();
  });

  it('non-installment credit-card charge WITH firstBilling uses index billing', () => {
    const r = assignOccurrenceBilling({
      isCreditCard: true,
      totalOccurrences: null,
      firstBillingMonth: 7,
      firstBillingYear: 2026,
      occurrenceNumber: 1,
      date: new Date('2026-07-15'),
      closingDay: 6,
    });
    expect(r).toEqual({ billingMonth: 7, billingYear: 2026 });
  });

  it('monthly fixed charge WITH firstBilling advances billing by occurrence (year cross)', () => {
    const r = assignOccurrenceBilling({
      isCreditCard: true,
      totalOccurrences: null,
      firstBillingMonth: 12,
      firstBillingYear: 2026,
      occurrenceNumber: 2,
      date: new Date('2027-01-10'),
      closingDay: 6,
    });
    expect(r).toEqual({ billingMonth: 1, billingYear: 2027 });
  });

  it('one-time avulsa (totalOccurrences=1) WITH firstBilling lands on the chosen fatura', () => {
    const r = assignOccurrenceBilling({
      isCreditCard: true,
      totalOccurrences: 1,
      firstBillingMonth: 6,
      firstBillingYear: 2026,
      occurrenceNumber: 1,
      date: new Date('2026-07-03'),
      closingDay: 6,
    });
    expect(r).toEqual({ billingMonth: 6, billingYear: 2026 });
  });

  it('non-installment WITHOUT firstBilling still falls back to closing-day date logic', () => {
    const r = assignOccurrenceBilling({
      isCreditCard: true,
      totalOccurrences: null,
      firstBillingMonth: null,
      firstBillingYear: null,
      occurrenceNumber: 1,
      // Local-constructed (not ISO) so getDate() is TZ-stable: June 7 > closing 6 → next month.
      date: new Date(2026, 5, 7),
      closingDay: 6,
    });
    expect(r).toEqual({ billingMonth: 7, billingYear: 2026 });
  });
});

describe('computeFaturaDueDate', () => {
  // dueDay <= closingDay → the fatura is due in the calendar month AFTER billingMonth.
  it('close 28 / due 3, billingMonth June → due July 3 (next month)', () => {
    expect(dueDateParts(computeFaturaDueDate(6, 2026, 3, 28))).toEqual({
      year: 2026,
      month: 7,
      day: 3,
    });
  });

  it('close 30 / due 10, billingMonth June → due July 10 (next month)', () => {
    expect(dueDateParts(computeFaturaDueDate(6, 2026, 10, 30))).toEqual({
      year: 2026,
      month: 7,
      day: 10,
    });
  });

  // dueDay > closingDay → same calendar month as billingMonth.
  it('close 3 / due 13, billingMonth June → due June 13 (same month)', () => {
    expect(dueDateParts(computeFaturaDueDate(6, 2026, 13, 3))).toEqual({
      year: 2026,
      month: 6,
      day: 13,
    });
  });

  it('close 10 / due 20, billingMonth June → due June 20 (same month)', () => {
    expect(dueDateParts(computeFaturaDueDate(6, 2026, 20, 10))).toEqual({
      year: 2026,
      month: 6,
      day: 20,
    });
  });

  // December → January rollover (next-month case crosses the year boundary).
  it('close 28 / due 3, billingMonth December → due Jan 3 of next year', () => {
    expect(dueDateParts(computeFaturaDueDate(12, 2026, 3, 28))).toEqual({
      year: 2027,
      month: 1,
      day: 3,
    });
  });

  // Feb clamp: due 31, close 31 → dueDay <= closingDay → next month (Feb),
  // clamped to the month's last day.
  it('close 31 / due 31, billingMonth January (non-leap) → clamped to Feb 28', () => {
    expect(dueDateParts(computeFaturaDueDate(1, 2026, 31, 31))).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
  });

  it('close 31 / due 31, billingMonth January (leap year) → clamped to Feb 29', () => {
    expect(dueDateParts(computeFaturaDueDate(1, 2024, 31, 31))).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
  });

  // Same-month short case: due 31, close 28 → due > close → same month (June, 30 days) → clamp.
  it('close 28 / due 31, billingMonth June → same month, clamped to June 30', () => {
    expect(dueDateParts(computeFaturaDueDate(6, 2026, 31, 28))).toEqual({
      year: 2026,
      month: 6,
      day: 30,
    });
  });

  // Boundary: dueDay == closingDay → next month (rule is dueDay <= closingDay).
  it('close 15 / due 15, billingMonth June → next month (July 15)', () => {
    expect(dueDateParts(computeFaturaDueDate(6, 2026, 15, 15))).toEqual({
      year: 2026,
      month: 7,
      day: 15,
    });
  });
});
