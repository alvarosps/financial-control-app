import { describe, expect, it } from 'vitest';
import { monthYearLabel } from '@/lib/labels';

describe('monthYearLabel', () => {
  it('renders the short pt-BR month with the trailing dot stripped and a 4-digit year', () => {
    const label = monthYearLabel({ month: 8, year: 2026 });
    expect(label).toBe('ago/2026');
    expect(label).not.toMatch(/\./);
  });

  it('handles a single-digit month without a trailing dot', () => {
    const label = monthYearLabel({ month: 1, year: 2026 });
    expect(label).toBe('jan/2026');
    expect(label.endsWith('.')).toBe(false);
  });

  it('supports a compact 2-digit-year variant that also drops the dot', () => {
    const label = monthYearLabel({ month: 6, year: 2026 }, 2);
    expect(label).toBe('jun/26');
    expect(label).not.toMatch(/\./);
  });
});
