import { boolean, date, integer, numeric, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { frequencyEnum, incomeCategoryEnum } from './enums.ts';

export const incomeSourceConfigs = pgTable('income_source_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' })
    .unique(),
  frequency: frequencyEnum('frequency').notNull(),
  category: incomeCategoryEnum('category').notNull(),
  paymentDay: integer('payment_day'),
  exchangeRate: numeric('exchange_rate', { precision: 10, scale: 6 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // Biweekly cadence phase reference (a real pay date). When set, the
  // materializer steps the 14-day cadence from here instead of the schedule's
  // startDate, so occurrences land on the correct days.
  biweeklyAnchor: date('biweekly_anchor'),
  conversionFeePercent: numeric('conversion_fee_percent', { precision: 5, scale: 2 })
    .notNull()
    .default('0'),
  autoCreditByDate: boolean('auto_credit_by_date').notNull().default(false),
});
