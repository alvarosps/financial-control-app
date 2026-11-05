import { getBrNationalHolidays } from './br-holidays.ts';

export function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function key(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Roll `date` BACKWARD to the nearest business day, skipping weekends and BR
 * national holidays. Used for CLT salary pay dates that anticipate when the
 * nominal day falls on a non-business day. Pure; constructs LOCAL dates to match
 * the occurrence engine.
 */
export function previousBusinessDay(date: Date): Date {
  let d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  while (isWeekend(d) || getBrNationalHolidays(d.getFullYear()).has(key(d))) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  }
  return d;
}
