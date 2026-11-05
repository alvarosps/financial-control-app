/**
 * Date helpers for <input type="date"> values (YYYY-MM-DD).
 *
 * Rules:
 * - "Today" defaults use the local calendar day; new Date().toISOString() is UTC
 *   and can become tomorrow late at night in UTC-3.
 * - DB date columns deserialize as UTC-midnight Date values, so Date formatting
 *   uses the UTC calendar day.
 * - Parsing an input value uses local noon to avoid day shifts when serialized.
 */

export function todayLocalISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function toDateInputValue(value: string | Date | null | undefined, fallback = ''): string {
  if (value == null) return fallback;

  if (typeof value === 'string') {
    const match = value.match(/^\d{4}-\d{2}-\d{2}/);
    if (match) return match[0];

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return fallback;
    return parsed.toISOString().split('T')[0];
  }

  if (Number.isNaN(value.getTime())) return fallback;
  return value.toISOString().split('T')[0];
}

export function dateInputToDate(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

const SAO_PAULO_TIME_ZONE = 'America/Sao_Paulo';
const MILLISECONDS_PER_DAY = 86_400_000;

function civilDayOrdinal(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY;
}

function saoPauloCalendarDate(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SAO_PAULO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value),
    day: Number(parts.find((part) => part.type === 'day')?.value),
  };
}

/** Returns an ISO date offset by calendar days in America/Sao_Paulo. */
export function daysAgoSaoPauloISO(days: number, now: Date = new Date()): string {
  const today = saoPauloCalendarDate(now);
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/**
 * True when a YYYY-MM-DD date falls in [today, today + days] using the
 * America/Sao_Paulo calendar. UTC civil-day ordinals keep this stable across
 * device time zones and daylight-saving transitions.
 */
export function isWithinDays(isoDate: string, days: number, now: Date = new Date()): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match || !Number.isInteger(days) || days < 0) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dueDate = new Date(Date.UTC(year, month - 1, day));
  if (
    dueDate.getUTCFullYear() !== year ||
    dueDate.getUTCMonth() !== month - 1 ||
    dueDate.getUTCDate() !== day
  ) {
    return false;
  }

  const today = saoPauloCalendarDate(now);
  const diffDays =
    civilDayOrdinal(year, month, day) - civilDayOrdinal(today.year, today.month, today.day);
  return diffDays >= 0 && diffDays <= days;
}
