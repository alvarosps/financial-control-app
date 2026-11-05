import { describe, expect, it } from 'vitest';
import { APP_TIME_ZONE, currentMonthYear } from './current-month';

describe('currentMonthYear', () => {
  it('exports the app timezone constant', () => {
    expect(APP_TIME_ZONE).toBe('America/Sao_Paulo');
  });
  it('resolves month/year in America/Sao_Paulo, not UTC', () => {
    expect(currentMonthYear(new Date('2026-01-01T00:30:00Z'))).toEqual({ month: 12, year: 2025 });
  });
  it('handles plain mid-month instants', () => {
    expect(currentMonthYear(new Date('2026-07-04T15:00:00Z'))).toEqual({ month: 7, year: 2026 });
  });
  it('defaults to now and returns sane bounds', () => {
    const { month, year } = currentMonthYear();
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    expect(year).toBeGreaterThanOrEqual(2026);
  });
});
