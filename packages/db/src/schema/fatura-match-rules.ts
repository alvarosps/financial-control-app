import { index, pgTable, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { scheduledTransactions } from './scheduled-transactions.ts';
import { userProfiles } from './users.ts';

export const faturaMatchRules = pgTable(
  'fatura_match_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    cardAccountId: uuid('card_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    rawNormalized: varchar('raw_normalized', { length: 300 }).notNull(),
    targetScheduleId: uuid('target_schedule_id')
      .notNull()
      .references(() => scheduledTransactions.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('fatura_match_rules_user_card_raw_unique').on(
      table.userId,
      table.cardAccountId,
      table.rawNormalized,
    ),
    index('fatura_match_rules_user_card_idx').on(table.userId, table.cardAccountId),
    index('fatura_match_rules_schedule_idx').on(table.targetScheduleId),
  ],
);
