import { defaultLocale } from '@/i18n/config';

/**
 * Helpers that turn raw domain enum values (loan_type, account_type, etc.)
 * into translated user-facing labels. Components must call these from a
 * client- or server-component where a `t` instance is available — we never
 * cache PT strings in module-level constants.
 */

type Translator = (key: string) => string;

function safeT(t: Translator, key: string, fallback: string): string {
  try {
    const v = t(key);
    return v && v !== key ? v : fallback;
  } catch {
    return fallback;
  }
}

export function getLoanTypeLabel(t: Translator, type: string | null | undefined): string {
  if (!type) return '';
  return safeT(t, `loans.types.${type}`, type);
}

export function getLoanCategoryLabel(t: Translator, category: string | null | undefined): string {
  if (!category) return '';
  return safeT(t, `loans.categories.${category}`, category);
}

export function getAccountTypeLabel(t: Translator, type: string | null | undefined): string {
  if (!type) return '';
  return safeT(t, `accounts.types.${type}`, type);
}

export function getFrequencyLabel(t: Translator, freq: string | null | undefined): string {
  if (!freq) return '';
  return safeT(t, `accounts.frequency.${freq}`, freq);
}

export function getIncomeCategoryLabel(t: Translator, key: string | null | undefined): string {
  if (!key) return '';
  return safeT(t, `income.categories.${key}`, key);
}

export function getChargeKindLabel(t: Translator, frequency: string): string {
  return frequency === 'once' ? t('charges.kind.oneTime') : t('charges.kind.fixed');
}

/**
 * Localised month name for 1-based month index. Uses the browser/runtime
 * `Intl.DateTimeFormat` so locale changes (future locale switcher) don't
 * require a code change.
 */
export function getMonthName(
  month: number,
  locale: string = defaultLocale,
  style: 'long' | 'short' = 'long',
): string {
  if (!Number.isFinite(month) || month < 1 || month > 12) return '';
  // Use a fixed reference year/day; UTC keeps it stable across timezones.
  const date = new Date(Date.UTC(2000, month - 1, 1));
  return new Intl.DateTimeFormat(locale, { month: style, timeZone: 'UTC' }).format(date);
}

/**
 * Canonical short "month/year" label for the simulator surfaces (KPIs, alerts,
 * month table). Intl pt-BR short month names carry a trailing dot ("ago."); we
 * strip it so every surface reads `ago/2026` consistently — never `ago./2026`.
 *
 * @param ref 1-based month + full year.
 * @param yearDigits 4 (default, full year) or 2 (compact, for space-constrained
 *   surfaces such as the chart X axis). Both forms drop the pt-BR trailing dot.
 */
export function monthYearLabel(
  ref: { month: number; year: number },
  yearDigits: 2 | 4 = 4,
  locale: string = defaultLocale,
): string {
  const month = getMonthName(ref.month, locale, 'short').replace(/\.$/, '');
  const year = yearDigits === 2 ? String(ref.year).slice(2) : String(ref.year);
  return `${month}/${year}`;
}
