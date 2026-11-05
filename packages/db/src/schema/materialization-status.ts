import { date, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { userProfiles } from './users.ts';

export const materializationStatus = pgTable('materialization_status', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => userProfiles.id, { onDelete: 'cascade' })
    .unique(),
  lastMaterializedAt: timestamp('last_materialized_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  horizonEnd: date('horizon_end').notNull(),
  schedulesHash: varchar('schedules_hash', { length: 100 }).notNull(),
});
