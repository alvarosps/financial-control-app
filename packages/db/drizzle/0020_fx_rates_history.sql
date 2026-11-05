-- Manual migration (psql, pattern 0009/0011/0012 -- NOT journaled).
-- Applied: 2026-07-09
--
-- fx_rates stored only the LAST rate per pair (UNIQUE(base,quote)) despite
-- having fetched_on. It now stores one row per pair per day via
-- UNIQUE(base,quote,fetched_on), preserving history for revaluation.
-- FxRateService reads the latest row (ORDER BY fetched_on DESC LIMIT 1).
-- Existing data already satisfies the new constraint.

ALTER TABLE fx_rates DROP CONSTRAINT IF EXISTS fx_rates_base_quote_unique;
ALTER TABLE fx_rates ADD CONSTRAINT fx_rates_base_quote_fetched_on_unique
  UNIQUE (base_currency, quote_currency, fetched_on);
