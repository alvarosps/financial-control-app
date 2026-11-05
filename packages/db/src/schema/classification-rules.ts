import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { categories } from './categories.ts';
import { userProfiles } from './users.ts';

export type ClassificationState = {
  categoryId: string | null;
  classificationSource: 'unreviewed' | 'manual' | 'rule';
  classificationRuleId: string | null;
  classificationRuleVersion: number | null;
  classificationConfidence: 'exact' | 'ambiguous' | null;
  classificationReviewedAt: string | null;
  economicResponsibility: 'unknown' | 'own' | 'family' | 'work' | 'property';
  receivableAccountId: string | null;
};

export const classificationRules = pgTable(
  'classification_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    merchant: varchar('merchant', { length: 500 }).notNull(),
    cardAccountId: uuid('card_account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    priority: integer('priority').notNull().default(0),
    version: integer('version').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('classification_rules_owner_idx').on(t.userId, t.merchant),
    check(
      'classification_rules_values',
      sql`${t.version} > 0 AND ${t.priority} BETWEEN 0 AND 1000 AND length(btrim(${t.merchant})) > 0`,
    ),
  ],
);

export const classificationBatches = pgTable(
  'classification_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    items: jsonb('items')
      .$type<{ transactionId: string; before: ClassificationState; afterVersion: string }[]>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoReason: text('undo_reason'),
  },
  (t) => [
    index('classification_batches_owner_idx').on(t.userId, t.createdAt),
    check(
      'classification_batches_values',
      sql`jsonb_typeof(${t.items}) = 'array' AND jsonb_array_length(${t.items}) BETWEEN 1 AND 100 AND ((${t.undoneAt} IS NULL AND ${t.undoReason} IS NULL) OR (${t.undoneAt} IS NOT NULL AND length(btrim(${t.undoReason})) >= 3))`,
    ),
  ],
);
