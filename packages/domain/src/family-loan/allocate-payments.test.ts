import { describe, expect, it } from 'vitest';
import { Money } from '../money.ts';
import { allocateFamilyLoanPayments } from './allocate-payments.ts';

const m = (n: number) => Money.fromNumber(n, 'BRL');

describe('allocateFamilyLoanPayments', () => {
  it('marks a fully-paid current month as paid (single payment)', () => {
    const r = allocateFamilyLoanPayments(
      [{ monthKey: '2026-06', owed: m(5000) }],
      [{ date: '2026-06-10', amount: m(5000) }],
      '2026-06',
    );
    expect(r.months[0]).toMatchObject({ owed: 5000, paid: 5000, remaining: 0, status: 'paid' });
    expect(r.totals.totalOutstanding).toBe(0);
  });

  it('supports multiple partial payments accumulating to the total', () => {
    const r = allocateFamilyLoanPayments(
      [{ monthKey: '2026-06', owed: m(5000) }],
      [
        { date: '2026-06-05', amount: m(500) },
        { date: '2026-06-10', amount: m(2000) },
        { date: '2026-06-20', amount: m(2500) },
      ],
      '2026-06',
    );
    expect(r.months[0]).toMatchObject({ paid: 5000, remaining: 0, status: 'paid' });
  });

  it('applies oldest-first across months (May->June carry-over)', () => {
    const r = allocateFamilyLoanPayments(
      [
        { monthKey: '2026-05', owed: m(5000) },
        { monthKey: '2026-06', owed: m(5000) },
      ],
      [
        { date: '2026-05-31', amount: m(4000) },
        { date: '2026-06-15', amount: m(2000) },
      ],
      '2026-06',
    );
    const may = r.months.find((x) => x.monthKey === '2026-05');
    const jun = r.months.find((x) => x.monthKey === '2026-06');
    expect(may).toMatchObject({ paid: 5000, remaining: 0, status: 'paid' });
    expect(jun).toMatchObject({ paid: 1000, remaining: 4000, status: 'partially_paid' });
  });

  it('marks a past month with remaining > 0 as overdue', () => {
    const r = allocateFamilyLoanPayments(
      [{ monthKey: '2026-05', owed: m(5000) }],
      [{ date: '2026-05-31', amount: m(4000) }],
      '2026-06',
    );
    expect(r.months[0]).toMatchObject({ remaining: 1000, status: 'overdue' });
    expect(r.totals.totalOverdue).toBe(1000);
  });

  it('carries an overpayment as creditBalance abating the next positive month', () => {
    const r = allocateFamilyLoanPayments(
      [
        { monthKey: '2026-06', owed: m(1000) },
        { monthKey: '2026-07', owed: m(1000) },
      ],
      [{ date: '2026-06-10', amount: m(1500) }],
      '2026-06',
    );
    expect(r.months.find((x) => x.monthKey === '2026-06')).toMatchObject({
      remaining: 0,
      status: 'paid',
    });
    expect(r.months.find((x) => x.monthKey === '2026-07')).toMatchObject({
      paid: 500,
      remaining: 500,
    });
  });

  it('treats a negative owed month (discount > charges) as a credit, clamping remaining at 0', () => {
    const r = allocateFamilyLoanPayments([{ monthKey: '2026-06', owed: m(-200) }], [], '2026-06');
    expect(r.months[0]).toMatchObject({ remaining: 0, status: 'credit' });
    expect(r.totals.creditBalance).toBe(200);
  });

  it('H2: totalOutstanding counts only past+current months, not future ones', () => {
    const r = allocateFamilyLoanPayments(
      [
        { monthKey: '2026-04', owed: m(500) }, // past, unpaid
        { monthKey: '2026-06', owed: m(300) }, // current, unpaid
        { monthKey: '2026-08', owed: m(1000) }, // future, unpaid
        { monthKey: '2026-09', owed: m(1000) }, // future, unpaid
      ],
      [],
      '2026-06',
    );
    expect(r.totals.totalOutstanding).toBe(800); // 500 + 300, NOT + future 2000
    expect(r.totals.totalOverdue).toBe(500); // only the past month
    // future months still present as open in months[]
    expect(r.months.find((x) => x.monthKey === '2026-08')).toMatchObject({
      remaining: 1000,
      status: 'open',
    });
  });

  it('M4: a credit month (owed<0) abates a later month oldest-first', () => {
    const r = allocateFamilyLoanPayments(
      [
        { monthKey: '2026-05', owed: m(-300) },
        { monthKey: '2026-06', owed: m(1000) },
      ],
      [],
      '2026-07', // both past
    );
    expect(r.months.find((x) => x.monthKey === '2026-05')).toMatchObject({
      remaining: 0,
      status: 'credit',
    });
    expect(r.months.find((x) => x.monthKey === '2026-06')).toMatchObject({
      paid: 300,
      remaining: 700,
      status: 'overdue',
    });
    expect(r.totals.totalOutstanding).toBe(700);
    expect(r.totals.totalOverdue).toBe(700);
    expect(r.totals.totalOwed).toBe(700);
  });

  it('M4: credit before a positive month + exact net payment settles to zero', () => {
    const r = allocateFamilyLoanPayments(
      [
        { monthKey: '2026-06', owed: m(-200) },
        { monthKey: '2026-06', owed: m(1000) }, // same month two entries is fine
      ],
      [{ date: '2026-06-10', amount: m(800) }],
      '2026-06',
    );
    expect(r.totals.totalOutstanding).toBe(0);
  });
});
