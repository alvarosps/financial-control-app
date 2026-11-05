// Default swatch for entity colour pickers (categories, credit cards) before
// the user picks one or when the stored value is missing.
export const DEFAULT_ENTITY_COLOR = '#64748b';

// Chart colour palette (non-textual, locale-independent).
// Token-driven: resolves via globals.css --color-income/--color-expense + --chart-1..8
// so charts re-theme correctly in light/dark. Recharts <Cell fill> and inline
// styles accept these CSS-var strings.
export const CHART_COLORS = {
  income: 'var(--color-income)',
  expense: 'var(--color-expense)',
  grocery: 'var(--chart-3)',
  storeCards: 'var(--chart-6)',
  marketplaceLoans: 'var(--chart-7)',
  vehicle: 'var(--chart-2)',
  loans: 'var(--chart-4)',
  fixedExpenses: 'var(--chart-5)',
  other: 'var(--chart-8)',
} as const;
