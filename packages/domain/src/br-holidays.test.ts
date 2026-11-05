import { describe, expect, it } from 'vitest';
import { easterSunday, getBrNationalHolidays } from './br-holidays.ts';

describe('easterSunday (Computus)', () => {
  it('computes known Easter Sundays', () => {
    // month is 0-based: 2=March, 3=April
    expect([easterSunday(2024).getMonth(), easterSunday(2024).getDate()]).toEqual([2, 31]);
    expect([easterSunday(2025).getMonth(), easterSunday(2025).getDate()]).toEqual([3, 20]);
    expect([easterSunday(2026).getMonth(), easterSunday(2026).getDate()]).toEqual([3, 5]);
  });
});

describe('getBrNationalHolidays', () => {
  it('includes fixed national holidays', () => {
    const h = getBrNationalHolidays(2026);
    expect(h.has('2026-01-01')).toBe(true);
    expect(h.has('2026-04-21')).toBe(true);
    expect(h.has('2026-09-07')).toBe(true);
    expect(h.has('2026-12-25')).toBe(true);
    expect(h.has('2026-11-20')).toBe(true); // Consciência Negra (national since 2024)
  });

  it('includes Easter-derived bank holidays', () => {
    // Easter 2026 = 2026-04-05 → Carnaval -47 = 2026-02-17,
    // Sexta-feira Santa -2 = 2026-04-03, Corpus Christi +60 = 2026-06-04
    const h = getBrNationalHolidays(2026);
    expect(h.has('2026-02-17')).toBe(true);
    expect(h.has('2026-04-03')).toBe(true);
    expect(h.has('2026-06-04')).toBe(true);
  });

  it('omits Consciência Negra before 2024', () => {
    expect(getBrNationalHolidays(2023).has('2023-11-20')).toBe(false);
  });
});
