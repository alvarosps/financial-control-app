import type { Frequency } from '@fc/shared';

// Monthly-equivalent multiplier for a recurring income source. 'once' is one-time → 0 (excluded from a monthly total).
export function frequencyToMonthly(freq: Frequency): number {
  switch (freq) {
    case 'weekly':
      return 4;
    case 'biweekly':
      return 2;
    case 'monthly':
      return 1;
    case 'bimonthly':
      return 1 / 2;
    case 'quarterly':
      return 1 / 3;
    case 'semiannual':
      return 1 / 6;
    case 'annual':
      return 1 / 12;
    case 'once':
      return 0;
    default:
      return 1;
  }
}
