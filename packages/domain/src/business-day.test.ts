import { describe, expect, it } from 'vitest';
import { isWeekend, previousBusinessDay } from './business-day.ts';

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('isWeekend', () => {
  it('flags Saturday and Sunday', () => {
    expect(isWeekend(new Date(2026, 1, 14))).toBe(true); // Sat 14 Feb 2026
    expect(isWeekend(new Date(2026, 1, 15))).toBe(true); // Sun 15 Feb 2026
    expect(isWeekend(new Date(2026, 1, 13))).toBe(false); // Fri
  });
});

describe('previousBusinessDay', () => {
  it('keeps a normal business day unchanged', () => {
    expect(iso(previousBusinessDay(new Date(2026, 5, 15)))).toBe('2026-06-15'); // Mon
  });

  it('rolls a weekend back to Friday', () => {
    // 15 Feb 2026 is a Sunday → previous business day is Fri 13 Feb 2026
    expect(iso(previousBusinessDay(new Date(2026, 1, 15)))).toBe('2026-02-13');
  });

  it('rolls a holiday back across the weekend', () => {
    // 1 May 2026 (Dia do Trabalho) is a Friday → previous business day Thu 30 Apr
    expect(iso(previousBusinessDay(new Date(2026, 4, 1)))).toBe('2026-04-30');
  });

  it('rolls back across a year boundary if needed', () => {
    // 1 Jan 2027 (Thu, holiday) → previous business day Wed 31 Dec 2026
    expect(iso(previousBusinessDay(new Date(2027, 0, 1)))).toBe('2026-12-31');
  });
});
