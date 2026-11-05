import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';

export const familyLoanConfigs = pgTable('family_loan_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' })
    .unique(),
  personName: varchar('person_name', { length: 200 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  receiptDay: integer('receipt_day').notNull().default(10),
});

export const borrowedCards = pgTable(
  'borrowed_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyLoanConfigId: uuid('family_loan_config_id')
      .notNull()
      .references(() => familyLoanConfigs.id, { onDelete: 'cascade' }),
    creditCardAccountId: uuid('credit_card_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    description: varchar('description', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('bc_config_idx').on(table.familyLoanConfigId),
    index('bc_card_idx').on(table.creditCardAccountId),
    unique('bc_unique').on(table.familyLoanConfigId, table.creditCardAccountId),
  ],
);
