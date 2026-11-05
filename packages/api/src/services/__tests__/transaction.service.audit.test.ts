import type { DbExecutor } from '@fc/db';
import { auditLog, transactions, userProfiles } from '@fc/db';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createCardWriteContext } from '../../lib/card-write-context.ts';
import { withRollback } from '../../test/with-rollback.ts';
import { AccountService } from '../account.service.ts';
import { TransactionService } from '../transaction.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const transactionService = new TransactionService(db);

  const [user] = await db
    .insert(userProfiles)
    .values({
      email: `audit-tx-${Date.now()}-${Math.random()}@example.com`,
      name: 'Audit TX User',
      passwordHash: 'hashed',
    })
    .returning();

  const expense = await accountService.create(user.id, {
    name: 'Expenses',
    type: 'expense',
    currency: 'BRL',
  });
  const creditCard = await accountService.create(user.id, {
    name: 'Credit Card',
    type: 'credit_card',
    currency: 'BRL',
  });
  const checking = await accountService.create(user.id, {
    name: 'Checking',
    type: 'checking',
    currency: 'BRL',
  });

  return { transactionService, userId: user.id, expense, creditCard, checking };
}

describe('TransactionService.create — audit log', () => {
  it('writes exactly one audit entry on successful create', async () => {
    await withRollback(async (db) => {
      const { transactionService, userId, expense, creditCard } = await seed(db);

      const tx = await transactionService.createWithinCardFlow(
        createCardWriteContext(userId),
        userId,
        {
          sourceAccountId: expense.id,
          destinationAccountId: creditCard.id,
          amount: '42.50',
          description: 'Audited tx',
          date: new Date('2026-03-15'),
        },
      );

      if (!tx) throw new Error('transaction was not returned');

      const entries = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.userId, userId),
            eq(auditLog.entityType, 'transaction'),
            eq(auditLog.entityId, tx.id),
          ),
        );

      expect(entries).toHaveLength(1);
      const entry = entries[0];
      if (!entry) throw new Error('audit entry missing');
      expect(entry.action).toBe('create');
      const newData = entry.newData as Record<string, unknown>;
      expect(newData.amount).toBe('42.50');
      expect(newData.sourceAccountId).toBe(expense.id);
      expect(newData.destinationAccountId).toBe(creditCard.id);
      expect(newData.description).toBe('Audited tx');
    });
  });

  it('does not write an audit entry when create fails (unknown destination)', async () => {
    await withRollback(async (db) => {
      const { transactionService, userId, expense } = await seed(db);

      await expect(
        transactionService.createWithinCardFlow(createCardWriteContext(userId), userId, {
          sourceAccountId: expense.id,
          destinationAccountId: '00000000-0000-0000-0000-000000000000',
          amount: '10.00',
          description: 'Should fail',
          date: new Date('2026-03-15'),
        }),
      ).rejects.toThrow();

      const entries = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, userId), eq(auditLog.entityType, 'transaction')));

      expect(entries).toHaveLength(0);
    });
  });

  it('rolls back the transaction row when the audit insert fails', async () => {
    await withRollback(async (db) => {
      const { transactionService, userId, checking, creditCard } = await seed(db);

      await db.execute(sql`
        ALTER TABLE audit_log
        ADD CONSTRAINT audit_log_reject_transaction_create
        CHECK (entity_type <> 'transaction') NOT VALID
      `);

      await expect(
        transactionService.createWithinCardFlow(createCardWriteContext(userId), userId, {
          sourceAccountId: checking.id,
          destinationAccountId: creditCard.id,
          amount: '42.50',
          description: 'Must rollback with audit',
          date: new Date('2026-03-15'),
        }),
      ).rejects.toThrow('insert into "audit_log"');

      const persisted = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.description, 'Must rollback with audit'),
          ),
        );
      expect(persisted).toHaveLength(0);
    });
  });
});
