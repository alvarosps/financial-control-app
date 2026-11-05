/**
 * Brazilian NATIONAL holidays, computed purely (no external data, no yearly
 * maintenance). Fixed-date holidays plus the Easter-derived bank holidays
 * (Carnaval, Sexta-feira Santa, Corpus Christi). Used to roll CLT pay dates
 * back to the previous business day. All dates are constructed LOCAL (to match
 * the occurrence engine), and keys are 'YYYY-MM-DD'.
 */

/** Easter Sunday (Gregorian) via the Anonymous Gregorian "Computus" algorithm. */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function key(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

const cache = new Map<number, Set<string>>();

/** Set of 'YYYY-MM-DD' national holidays for `year` (memoized). */
export function getBrNationalHolidays(year: number): Set<string> {
  const cached = cache.get(year);
  if (cached) return cached;

  const fixed: ReadonlyArray<readonly [number, number]> = [
    [1, 1],
    [4, 21],
    [5, 1],
    [9, 7],
    [10, 12],
    [11, 2],
    [11, 15],
    [12, 25],
  ];

  const set = new Set<string>();
  for (const [m, d] of fixed) set.add(key(new Date(year, m - 1, d)));
  // Consciência Negra is a NATIONAL holiday only from 2024 onward.
  if (year >= 2024) set.add(key(new Date(year, 10, 20)));

  const easter = easterSunday(year);
  set.add(key(addDays(easter, -47))); // Carnaval (terça)
  set.add(key(addDays(easter, -2))); // Sexta-feira Santa
  set.add(key(addDays(easter, 60))); // Corpus Christi

  cache.set(year, set);
  return set;
}
