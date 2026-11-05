import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { categories } from './categories.ts';
import { userProfiles } from './users.ts';

export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    month: integer('month').notNull(),
    year: integer('year').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('BRL'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'restrict' }),
    economicScope: varchar('economic_scope', { length: 12 })
      .$type<'all' | 'own' | 'family' | 'work' | 'property'>()
      .notNull()
      .default('all'),
    limitAmount: numeric('limit_amount', { precision: 12, scale: 2 }).notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('budgets_scope_unique').on(
      t.userId,
      t.year,
      t.month,
      sql`coalesce(${t.categoryId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.economicScope,
    ),
    check(
      'budgets_values',
      sql`${t.month} BETWEEN 1 AND 12 AND ${t.year} BETWEEN 2000 AND 2200 AND ${t.currency} = 'BRL' AND ${t.limitAmount} > 0 AND ${t.version} > 0 AND ${t.economicScope} IN ('all','own','family','work','property')`,
    ),
  ],
);
