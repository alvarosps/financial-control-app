import { describe, expect, it } from 'vitest';
import {
  purchaseApplicationAmounts,
  resolveEventRevision,
  transitionObservation,
} from './financial-events.ts';

describe('financial event identity and review', () => {
  it('treats identical replay as a no-op and changed content at the same version as a conflict', () => {
    expect(resolveEventRevision(2, 'a', 2, 'a')).toBe('replay');
    expect(() => resolveEventRevision(2, 'a', 2, 'b')).toThrow();
    expect(resolveEventRevision(2, 'a', 3, 'b')).toBe('advance');
  });
  it('does not replace a posted revision with an older late-arriving pending event', () => {
    expect(resolveEventRevision(3, 'posted', 1, 'pending')).toBe('stale');
  });
  it('reopens review after an applied purchase changes without changing its financial application', () => {
    expect(
      transitionObservation(
        { review: 'accepted', application: 'created', manuallyCorrected: false },
        'posted',
        true,
      ),
    ).toEqual({ review: 'needs_review', application: 'created', updateFields: false });
  });
  it('preserves a manual correction and a deliberate ignore across parser revisions', () => {
    expect(
      transitionObservation(
        { review: 'unreviewed', application: 'unapplied', manuallyCorrected: true },
        'posted',
        true,
      ),
    ).toMatchObject({ review: 'needs_review', updateFields: false });
    expect(
      transitionObservation(
        { review: 'ignored', application: 'unapplied', manuallyCorrected: false },
        'posted',
        true,
      ),
    ).toMatchObject({ review: 'ignored', updateFields: false });
  });
  it('keeps a cancelled purchase applied and requests review rather than deleting its debt', () => {
    expect(
      transitionObservation(
        { review: 'accepted', application: 'linked', manuallyCorrected: false },
        'retracted',
        false,
      ),
    ).toEqual({ review: 'needs_review', application: 'linked', updateFields: false });
  });
  it('does not accept an observed purchase just because its source now says posted', () => {
    expect(
      transitionObservation(
        { review: 'unreviewed', application: 'unapplied', manuallyCorrected: false },
        'posted',
        false,
      ),
    ).toMatchObject({ review: 'unreviewed', application: 'unapplied', updateFields: true });
  });
});

describe('observed purchase amounts', () => {
  it('distinguishes purchase total from the amount of one installment', () => {
    const input = { amount: '120.00', currency: 'BRL', installmentNumber: 2, totalInstallments: 3 };
    expect(purchaseApplicationAmounts({ ...input, amountMeaning: 'purchase_total' })).toEqual({
      installmentAmount: '40.00',
      totalAmount: '120.00',
      installmentNumber: 2,
      totalInstallments: 3,
    });
    expect(purchaseApplicationAmounts({ ...input, amountMeaning: 'installment' })).toEqual({
      installmentAmount: '120.00',
      totalAmount: '360.00',
      installmentNumber: 2,
      totalInstallments: 3,
    });
  });
  it('requires amount meaning, complete installment identity and an exact split', () => {
    const input = { amount: '100.00', currency: 'BRL', installmentNumber: 1, totalInstallments: 3 };
    expect(() => purchaseApplicationAmounts({ ...input, amountMeaning: 'unknown' })).toThrow();
    expect(() =>
      purchaseApplicationAmounts({ ...input, amountMeaning: 'purchase_total' }),
    ).toThrow();
    expect(() =>
      purchaseApplicationAmounts({ ...input, amountMeaning: 'installment', installmentNumber: 4 }),
    ).toThrow();
    expect(() =>
      purchaseApplicationAmounts({
        ...input,
        amountMeaning: 'installment',
        installmentNumber: null,
      }),
    ).toThrow();
    expect(() =>
      purchaseApplicationAmounts({ ...input, amountMeaning: 'installment', amount: '-10.00' }),
    ).toThrow();
  });
});
