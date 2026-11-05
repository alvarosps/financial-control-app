import { date, numeric, pgTable, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';

export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    baseCurrency: varchar('base_currency', { length: 3 }).notNull(),
    quoteCurrency: varchar('quote_currency', { length: 3 }).notNull(),
    rate: numeric('rate', { precision: 18, scale: 6 }).notNull(),
    fetchedOn: date('fetched_on').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    source: varchar('source', { length: 60 }).notNull(),
  },
  (t) => [
    unique('fx_rates_base_quote_fetched_on_unique').on(
      t.baseCurrency,
      t.quoteCurrency,
      t.fetchedOn,
    ),
  ],
);
