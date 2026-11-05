import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  numeric,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { cardGroupEnum } from './enums.ts';

export const creditCardConfigs = pgTable(
  'credit_card_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' })
      .unique(),
    closingDay: integer('closing_day').notNull(),
    dueDay: integer('due_day').notNull(),
    creditLimit: numeric('credit_limit', { precision: 12, scale: 2 }),
    billParserType: varchar('bill_parser_type', { length: 50 }),
    isDueDayVariable: boolean('is_due_day_variable').notNull().default(false),
    cardGroup: cardGroupEnum('card_group').notNull().default('credit_card'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('credit_card_configs_closing_day_check', sql`${table.closingDay} BETWEEN 1 AND 31`),
    check('credit_card_configs_due_day_check', sql`${table.dueDay} BETWEEN 1 AND 31`),
  ],
);
