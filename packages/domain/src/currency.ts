// Scoped to the currencies this app actually handles. Extend when a new
// currency is introduced — keeping the set small prevents typos slipping
// through unnoticed (an invalid code would otherwise only fail later, at
// format/lookup time, far from its source).
export const SUPPORTED_CURRENCIES = new Set(['BRL', 'USD', 'EUR', 'GBP'] as const);
export type SupportedCurrency = 'BRL' | 'USD' | 'EUR' | 'GBP';

const ISO_4217_RE = /^[A-Z]{3}$/;

export function isIso4217(code: string): code is SupportedCurrency {
  return ISO_4217_RE.test(code) && SUPPORTED_CURRENCIES.has(code as SupportedCurrency);
}

export function assertIso4217(code: string): asserts code is SupportedCurrency {
  if (!isIso4217(code)) {
    throw new Error(
      `Invalid currency code: ${JSON.stringify(code)} (expected ISO-4217 from supported set)`,
    );
  }
}
