// Node and browser ICU can emit different whitespace (U+00A0 / U+202F) around
// the currency symbol and percent sign. Normalize to a plain space so server-
// and client-rendered output are byte-identical (prevents hydration mismatch).
const INTL_SPACES = /[  ]/g;

export function formatCurrencyValue(value: number, currency = 'BRL'): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency })
    .format(value)
    .replace(INTL_SPACES, ' ');
}

export function formatCurrency(value: number, currency = 'BRL'): string {
  return formatCurrencyValue(value, currency);
}

export function formatPercent(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 2 })
    .format(value / 100)
    .replace(INTL_SPACES, ' ');
}

/** Format a YYYY-MM-DD ISO date as DD/MM without timezone conversion. */
export function formatDueDate(isoDate: string): string {
  // Parse YYYY-MM-DD without timezone conversion by splitting manually.
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
  });
}

/**
 * Compact BRL for chart axes: R$ 1,2k / R$ 2,5M / R$ 950 (pt-BR decimals).
 * Sub-thousand values are shown whole; sign comes first (-R$ 250k).
 */
export function formatCompactBRL(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const oneDecimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

  if (abs >= 1_000_000) return `${sign}R$ ${oneDecimal.format(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}R$ ${oneDecimal.format(abs / 1_000)}k`;

  const whole = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  return `${sign}R$ ${whole.format(abs)}`;
}
