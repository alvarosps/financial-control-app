export const locales = ['pt-BR', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'pt-BR';
export const localeCookieName = 'fc-locale';

export function isLocale(value: unknown): value is Locale {
  return locales.some((locale) => locale === value);
}
