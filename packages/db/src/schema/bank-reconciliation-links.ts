import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { externalMovements } from './external-connections.ts';
import { transactions } from './transactions.ts';
import { userProfiles } from './users.ts';

export const bankReconciliationLinks = pgTable(
  'bank_reconciliation_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    movementId: uuid('movement_id')
      .notNull()
      .references(() => externalMovements.id, { onDelete: 'restrict' }),
    movementVersion: integer('movement_version').notNull(),
    walletAccountId: uuid('wallet_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'restrict' }),
    transactionFingerprint: varchar('transaction_fingerprint', { length: 64 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('bank_reconciliation_owner_idx').on(t.userId, t.movementId),
    uniqueIndex('bank_reconciliation_active_leg')
      .on(t.walletAccountId, t.transactionId)
      .where(sql`${t.revokedAt} IS NULL`),
    check(
      'bank_reconciliation_values',
      sql`${t.amount} > 0 AND ${t.movementVersion} > 0 AND ${t.transactionFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
