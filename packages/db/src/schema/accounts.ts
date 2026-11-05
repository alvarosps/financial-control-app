import type { CashAnchorBasis } from '@fc/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accountTypeEnum, sharePermissionEnum } from './enums.ts';
import { userProfiles } from './users.ts';

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    type: accountTypeEnum('type').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('BRL'),
    currentBalance: numeric('current_balance', { precision: 12, scale: 2 }).notNull().default('0'),
    icon: varchar('icon', { length: 50 }),
    color: varchar('color', { length: 20 }),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    overdraftLimit: numeric('overdraft_limit', { precision: 12, scale: 2 }),
    cdiPercentage: numeric('cdi_percentage', { precision: 6, scale: 2 }),
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle requires `any` for self-referential foreign keys
    parentAccountId: uuid('parent_account_id').references((): any => accounts.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    openingBalance: numeric('opening_balance', { precision: 12, scale: 2 }).notNull().default('0'),
    openingBalanceAnchorAt: timestamp('opening_balance_anchor_at', { withTimezone: true }),
    isDefaultWallet: boolean('is_default_wallet').notNull().default(false),
    cashAnchorBasis: varchar('cash_anchor_basis', { length: 20 })
      .$type<CashAnchorBasis>()
      .notNull()
      .default('recorded'),
  },
  (table) => [
    index('accounts_user_idx').on(table.userId),
    check('accounts_cash_anchor_basis', sql`${table.cashAnchorBasis} IN ('recorded','effective')`),
    index('accounts_user_active_idx').on(table.userId, table.isActive),
    index('accounts_user_type_idx').on(table.userId, table.type),
    index('accounts_parent_idx').on(table.parentAccountId),
    uniqueIndex('accounts_default_wallet_unique')
      .on(table.userId)
      .where(sql`is_default_wallet = true`),
  ],
);

export const accountShares = pgTable(
  'account_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sharedWithUserId: uuid('shared_with_user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    permission: sharePermissionEnum('permission').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('account_shares_unique').on(table.accountId, table.sharedWithUserId)],
);
