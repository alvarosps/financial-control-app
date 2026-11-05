import { describe, expect, it } from 'vitest';
import { dateAt, daysInMonth, isoDateKey, monthAt, startOfDay } from './dates.ts';

// Fixed reference: 2026-07-13 (local).
const REF = new Date(2026, 6, 13);

describe('monthAt', () => {
  it('offset 0 is the reference month', () => {
    expect(monthAt(REF, 0)).toEqual({ year: 2026, month: 7 });
  });

  it('negative offsets cross year boundaries backwards', () => {
    expect(monthAt(REF, -14)).toEqual({ year: 2025, month: 5 });
    expect(monthAt(REF, -7)).toEqual({ year: 2025, month: 12 });
    expect(monthAt(REF, -6)).toEqual({ year: 2026, month: 1 });
  });

  it('positive offsets cross year boundaries forward', () => {
    expect(monthAt(REF, 6)).toEqual({ year: 2027, month: 1 });
    expect(monthAt(REF, 5)).toEqual({ year: 2026, month: 12 });
  });
});

describe('daysInMonth', () => {
  it('handles short months and leap years', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe('dateAt', () => {
  it('builds a local-midnight date at the offset month', () => {
    const d = dateAt(REF, -8, 15);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(10); // November
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(0);
  });

  it('clamps day 31 to short months', () => {
    const feb = dateAt(REF, -5, 31); // Feb 2026
    expect(feb.getMonth()).toBe(1);
    expect(feb.getDate()).toBe(28);
  });

  it('clamps day below 1 up to 1', () => {
    const d = dateAt(REF, 0, 0);
    expect(d.getDate()).toBe(1);
  });
});

describe('startOfDay', () => {
  it('drops the time-of-day', () => {
    const d = startOfDay(new Date(2026, 6, 13, 17, 45, 12));
    expect(d.getTime()).toBe(new Date(2026, 6, 13).getTime());
  });
});

describe('isoDateKey', () => {
  it('slices string dates', () => {
    expect(isoDateKey('2026-07-13T00:00:00.000Z')).toBe('2026-07-13');
  });

  it('uses UTC parts for Date values (DB date-mode convention)', () => {
    expect(isoDateKey(new Date('2026-02-01T00:00:00.000Z'))).toBe('2026-02-01');
  });
});
