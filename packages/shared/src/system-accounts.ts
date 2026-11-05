/**
 * System-account identifiers seeded by the server. These are stored in the
 * database `accounts.name` column for bootstrapped records and are used as
 * lookup identifiers (not as user-facing display text).
 *
 * Keep these values exactly as stored in the seed migration — they are not
 * translations and must not change based on locale.
 */
export const SYSTEM_ACCOUNT_NAMES = {
  CREDIT_CARD_EXPENSES: 'Despesas Cartão',
} as const;
