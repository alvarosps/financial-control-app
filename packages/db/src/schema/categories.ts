import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { categoryTypeEnum } from './enums.ts';
import { userProfiles } from './users.ts';

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    type: categoryTypeEnum('type').notNull(),
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle requires `any` for self-referential foreign keys
    parentId: uuid('parent_id').references((): any => categories.id, { onDelete: 'set null' }),
    icon: varchar('icon', { length: 50 }),
    color: varchar('color', { length: 20 }),
    isSystem: boolean('is_system').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('categories_user_idx').on(table.userId),
    unique('categories_unique_name').on(table.userId, table.name),
  ],
);
