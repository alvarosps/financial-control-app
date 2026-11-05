import { afterEach, describe, expect, it, vi } from 'vitest';
import { dateInputToDate, toDateInputValue, todayLocalISO } from './dates';

describe('todayLocalISO', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the local calendar day late at night', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 31, 23, 30));
    expect(todayLocalISO()).toBe('2026-01-31');
  });

  it('zero-pads month and day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 5, 10, 0));
    expect(todayLocalISO()).toBe('2026-03-05');
  });
});

describe('toDateInputValue', () => {
  it('uses a YYYY-MM-DD string prefix verbatim', () => {
    expect(toDateInputValue('2026-03-05')).toBe('2026-03-05');
    expect(toDateInputValue('2026-03-05T00:00:00.000Z')).toBe('2026-03-05');
  });

  it('formats UTC-midnight Date values by UTC calendar day', () => {
    expect(toDateInputValue(new Date('2026-03-05T00:00:00.000Z'))).toBe('2026-03-05');
  });

  it('returns fallback for nullish and invalid values', () => {
    expect(toDateInputValue(null)).toBe('');
    expect(toDateInputValue(undefined)).toBe('');
    expect(toDateInputValue(new Date('nonsense'))).toBe('');
    expect(toDateInputValue(null, '2026-01-01')).toBe('2026-01-01');
    expect(toDateInputValue('nonsense', '2026-01-01')).toBe('2026-01-01');
  });
});

describe('dateInputToDate', () => {
  it('produces a Date at local noon for the provided day', () => {
    const d = dateInputToDate('2026-03-05');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(5);
    expect(d.getHours()).toBe(12);
  });
});
