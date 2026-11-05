import type { DbExecutor } from '@fc/db';
import { borrowedCards, scheduledTransactions, transactions, userProfiles } from '@fc/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { reviewAndClose } from '../test/closing-fixture.ts';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';

async function seed(db: DbExecutor) {
  const accountService = new AccountService(db);
  const ccFlowService = new CreditCardFlowService(db);
  const flowService = new FamilyLoanFlowService(db);

  const [user] = await db
    .insert(userProfiles)
    .values({
      email: 'family-loan@test.com',
      name: 'Test',
      passwordHash: 'hash',
    })
    .returning();

  await accountService.create(user.id, { name: 'Bank', type: 'checking', currency: 'BRL' });

  return { accountService, ccFlowService, flowService, userId: user.id };
}

describe('FamilyLoanFlowService', () => {
  it('does not clone a closed one-time family adjustment into a future month', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Family' });
      const { schedule } = await flowService.addDiscount(userId, {
        configId: config.id,
        description: 'Closed one-time discount',
        amount: '50.00',
        date: new Date('2026-08-10'),
      });
      await reviewAndClose(db, userId, 8, 2026);
      const before = await db
        .select()
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));
      await expect(
        flowService.editAdjustment(userId, {
          scheduleId: schedule.id,
          description: 'Moved to September',
          amount: '60.00',
          date: new Date('2026-09-10'),
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(
        await db
          .select()
          .from(transactions)
          .where(eq(transactions.scheduledTransactionId, schedule.id)),
      ).toEqual(before);
    });
  });
  it.each([
    'installment',
    'discount',
  ] as const)('edits future family %s occurrences while preserving the unpaid closed history', async (kind) => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Family' });
      const { schedule } =
        kind === 'installment'
          ? await flowService.addInstallment(userId, {
              configId: config.id,
              description: 'Family installments',
              amount: '100.00',
              totalInstallments: 4,
              currentInstallment: 1,
              dueDay: 10,
              billingMonth: 8,
              billingYear: 2026,
            })
          : await flowService.addDiscount(userId, {
              configId: config.id,
              description: 'Family discount',
              amount: '100.00',
              date: new Date('2026-08-10'),
              totalInstallments: 4,
              currentInstallment: 1,
              dueDay: 10,
            });
      const [closed] = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.date, new Date('2026-08-10')),
          ),
        );
      expect(closed).toMatchObject({ amount: '100.00', isPaid: false });
      await reviewAndClose(db, userId, 8, 2026, 'Family receivable remains pending');
      if (kind === 'installment') {
        await flowService.editInstallment(userId, {
          scheduleId: schedule.id,
          description: 'Future revised',
          amount: '120.00',
          totalInstallments: 4,
          currentInstallment: 2,
          currentBillingMonth: 9,
          currentBillingYear: 2026,
        });
      } else {
        await flowService.editAdjustment(userId, {
          scheduleId: schedule.id,
          description: 'Future revised',
          amount: '120.00',
          date: new Date('2026-09-10'),
          totalInstallments: 4,
          currentInstallment: 2,
          dueDay: 10,
        });
      }
      expect(
        (await db.select().from(transactions).where(eq(transactions.id, closed.id)))[0],
      ).toEqual(closed);
      expect(
        await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.scheduledTransactionId, schedule.id),
              eq(transactions.date, new Date('2026-09-10')),
            ),
          ),
      ).toMatchObject([{ amount: '120.00', description: 'Future revised' }]);
    });
  });
  it('creates family loan with account + config', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { account, config } = await flowService.createFamilyLoan(userId, {
        personName: 'Célia',
        notes: 'Irmã',
      });

      expect(account.type).toBe('family_loan');
      expect(account.name).toBe('Célia');
      expect(config.personName).toBe('Célia');
      expect(config.notes).toBe('Irmã');
      expect(config.isActive).toBe(true);
    });
  });

  it('adds borrowed card to a family loan config', async () => {
    await withRollback(async (db) => {
      const { flowService, ccFlowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      const { account: cardAccount } = await ccFlowService.createCreditCard(userId, {
        name: 'Nubank Célia',
        closingDay: 3,
        dueDay: 10,
      });

      const borrowedCard = await flowService.addBorrowedCard(userId, {
        configId: config.id,
        creditCardAccountId: cardAccount.id,
        description: 'Cartão principal da Célia',
      });

      expect(borrowedCard.familyLoanConfigId).toBe(config.id);
      expect(borrowedCard.creditCardAccountId).toBe(cardAccount.id);
      expect(borrowedCard.description).toBe('Cartão principal da Célia');

      const cards = await db
        .select()
        .from(borrowedCards)
        .where(eq(borrowedCards.familyLoanConfigId, config.id));
      expect(cards).toHaveLength(1);
    });
  });

  it('adds installment and materializes as deposit transactions', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });

      const { schedule, materialized } = await flowService.addInstallment(userId, {
        configId: config.id,
        description: 'TV Samsung - Reembolso Célia',
        amount: '300.00',
        totalInstallments: 10,
        currentInstallment: 3,
        dueDay: 10,
        billingMonth: 4,
        billingYear: 2026,
      });

      expect(schedule.domainType).toBe('family_loan_installment');
      expect(schedule.domainConfigId).toBe(config.id);
      expect(schedule.totalOccurrences).toBe(10);
      expect(schedule.startingOccurrence).toBe(1);
      expect(materialized.created).toBeGreaterThan(0);

      const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));

      expect(txs.length).toBeGreaterThan(0);
      expect(txs[0].type).toBe('deposit');
      expect(txs[0].domainType).toBe('family_loan_installment');
    });
  });

  it('adds fixed charge that recurs monthly', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });

      const { schedule } = await flowService.addFixedCharge(userId, {
        configId: config.id,
        description: 'Mensalidade fixa',
        amount: '500.00',
        startDate: new Date(2026, 3, 5),
        dueDay: 5,
      });

      expect(schedule.domainType).toBe('family_loan_fixed_charge');
      expect(schedule.isFixedCharge).toBe(true);
      expect(schedule.frequency).toBe('monthly');
    });
  });

  it('adds one-time charge', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });

      const { schedule, materialized } = await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'Pagamento pontual abril',
        amount: '200.00',
        date: new Date(2026, 3, 15),
      });

      expect(schedule.domainType).toBe('family_loan_expense');
      expect(schedule.frequency).toBe('once');
      expect(materialized.created).toBeGreaterThan(0);
    });
  });

  it('adds discount (subtracted from total)', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });

      const { schedule } = await flowService.addDiscount(userId, {
        configId: config.id,
        description: 'Desconto serviço prestado',
        amount: '100.00',
        date: new Date(2026, 3, 15),
      });

      expect(schedule.domainType).toBe('family_loan_discount');
      expect(schedule.frequency).toBe('once');
    });
  });

  it('adds discount installment with currentInstallment=3 backdated startDate and full series', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });

      const { schedule, materialized } = await flowService.addDiscount(userId, {
        configId: config.id,
        description: 'Desconto parcelado',
        amount: '50.00',
        date: new Date(2026, 5, 10),
        totalInstallments: 6,
        currentInstallment: 3,
        dueDay: 10,
      });

      expect(schedule.domainType).toBe('family_loan_discount');
      expect(schedule.frequency).toBe('monthly');
      expect(schedule.totalOccurrences).toBe(6);
      expect(schedule.startingOccurrence).toBe(1);
      expect(schedule.startDate.toISOString().slice(0, 10)).toBe('2026-04-01');
      expect(materialized.invalidSchedules).toEqual([]);

      const txs = await db
        .select()
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));

      expect(txs).toHaveLength(6);
    });
  });

  it('rejects addDiscount when currentInstallment exceeds totalInstallments', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });

      await expect(
        flowService.addDiscount(userId, {
          configId: config.id,
          description: 'Desconto invalido',
          amount: '50.00',
          date: new Date(2026, 5, 10),
          totalInstallments: 6,
          currentInstallment: 7,
          dueDay: 10,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  it('mutations are atomic when materialization fails', async () => {
    await withRollback(async (db) => {
      const { accountService, flowService, userId } = await seed(db);
      const { config, account } = await flowService.createFamilyLoan(userId, {
        personName: 'Celia',
      });
      const [otherUser] = await db
        .insert(userProfiles)
        .values({ email: 'family-loan-poison@test.com', name: 'Other', passwordHash: 'hash' })
        .returning();
      const otherAccount = await accountService.create(otherUser.id, {
        name: 'Other Bank',
        type: 'checking',
        currency: 'BRL',
      });

      await db.insert(scheduledTransactions).values({
        userId,
        sourceAccountId: otherAccount.id,
        destinationAccountId: account.id,
        amount: '10.00',
        description: 'poison schedule',
        frequency: 'monthly',
        startDate: new Date(2026, 0, 1),
        totalOccurrences: 5,
        startingOccurrence: 1,
        isActive: true,
      });

      await expect(
        flowService.addInstallment(userId, {
          configId: config.id,
          description: 'Installment',
          amount: '200.00',
          totalInstallments: 5,
          currentInstallment: 1,
          dueDay: 10,
          billingMonth: 6,
          billingYear: 2026,
        }),
      ).rejects.toThrow(/accountTypeMap/);

      await expect(
        flowService.addFixedCharge(userId, {
          configId: config.id,
          description: 'Fixed charge',
          amount: '50.00',
          startDate: new Date(2026, 5, 10),
          dueDay: 10,
        }),
      ).rejects.toThrow(/accountTypeMap/);

      await expect(
        flowService.addOneTimeCharge(userId, {
          configId: config.id,
          description: 'One time',
          amount: '80.00',
          date: new Date(2026, 5, 15),
        }),
      ).rejects.toThrow(/accountTypeMap/);

      await expect(
        flowService.addDiscount(userId, {
          configId: config.id,
          description: 'Discount',
          amount: '30.00',
          date: new Date(2026, 5, 15),
        }),
      ).rejects.toThrow(/accountTypeMap/);

      const orphans = await db
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.domainConfigId, config.id));
      expect(orphans).toHaveLength(0);
    });
  });

  it('edits an installment: new amount/total and recomputed current parcela', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });

      const { schedule } = await flowService.addInstallment(userId, {
        configId: config.id,
        description: 'TV Samsung',
        amount: '300.00',
        totalInstallments: 10,
        currentInstallment: 3,
        dueDay: 10,
        billingMonth: 4,
        billingYear: 2026,
      });

      const before = await flowService.getMonthlyTotal(userId, config.id, 6, 2026);
      const beforeParcela = before.items.installments[0].installmentNumber ?? 0;

      // Re-anchor: June 2026 is now parcela 8 of 12 at a new amount.
      await flowService.editInstallment(userId, {
        scheduleId: schedule.id,
        description: 'TV Samsung 4K',
        amount: '350.00',
        totalInstallments: 12,
        currentInstallment: 8,
        currentBillingMonth: 6,
        currentBillingYear: 2026,
      });

      const after = await flowService.getMonthlyTotal(userId, config.id, 6, 2026);
      expect(after.items.installments).toHaveLength(1);
      const item = after.items.installments[0];
      expect(item.description).toBe('TV Samsung 4K');
      expect(item.amount).toBe('350.00');
      expect(item.totalInstallments).toBe(12);
      // The June parcela shifted to reflect the new anchor (and differs from before).
      expect(item.installmentNumber).not.toBe(beforeParcela);
      expect(item.installmentNumber).not.toBeNull();
    });
  });

  it('edits a one-time expense and moves it to another month without duplication', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      const { schedule } = await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'Compra julho',
        amount: '200.00',
        date: new Date(Date.UTC(2026, 6, 15)),
      });

      await flowService.editAdjustment(userId, {
        scheduleId: schedule.id,
        description: 'Compra agosto',
        amount: '250.00',
        date: new Date(Date.UTC(2026, 7, 20)),
      });

      const july = await flowService.getMonthlyTotal(userId, config.id, 7, 2026);
      const august = await flowService.getMonthlyTotal(userId, config.id, 8, 2026);
      expect(july.items.expenses).toHaveLength(0);
      expect(august.items.expenses).toHaveLength(1);
      expect(august.items.expenses[0]).toMatchObject({
        description: 'Compra agosto',
        amount: '250.00',
      });
    });
  });

  it('edits one-time and installment discounts while preserving their reducing domain type', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      const once = await flowService.addDiscount(userId, {
        configId: config.id,
        description: 'Desconto julho',
        amount: '100.00',
        date: new Date(Date.UTC(2026, 6, 10)),
      });

      await flowService.editAdjustment(userId, {
        scheduleId: once.schedule.id,
        description: 'Desconto agosto',
        amount: '125.00',
        date: new Date(Date.UTC(2026, 7, 10)),
      });

      const installment = await flowService.addDiscount(userId, {
        configId: config.id,
        description: 'Desconto parcelado',
        amount: '50.00',
        date: new Date(Date.UTC(2026, 6, 10)),
        totalInstallments: 12,
        currentInstallment: 6,
        dueDay: 10,
      });

      await flowService.editAdjustment(userId, {
        scheduleId: installment.schedule.id,
        description: 'Desconto parcelado editado',
        amount: '55.00',
        date: new Date(Date.UTC(2026, 6, 10)),
        totalInstallments: 12,
        currentInstallment: 7,
        dueDay: 12,
      });

      const [updated] = await db
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, installment.schedule.id));
      expect(updated).toMatchObject({
        domainType: 'family_loan_discount',
        frequency: 'monthly',
        totalOccurrences: 12,
        startingOccurrence: 1,
        dueDay: 12,
      });
      expect(updated.startDate.toISOString().slice(0, 10)).toBe('2026-01-01');

      const august = await flowService.getMonthlyTotal(userId, config.id, 8, 2026);
      expect(august.discounts).toBeGreaterThanOrEqual(125);
      expect(
        august.items.discounts.every((item) => item.domainType === 'family_loan_discount'),
      ).toBe(true);
    });
  });

  it('rejects rewriting settled one-time adjustments', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      const paid = await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'Pago',
        amount: '100.00',
        date: new Date(Date.UTC(2026, 6, 5)),
      });
      const reversed = await flowService.addDiscount(userId, {
        configId: config.id,
        description: 'Estornado',
        amount: '30.00',
        date: new Date(Date.UTC(2026, 6, 6)),
      });
      await db
        .update(transactions)
        .set({ isPaid: true })
        .where(eq(transactions.scheduledTransactionId, paid.schedule.id));
      await db
        .update(transactions)
        .set({ isReversed: true })
        .where(eq(transactions.scheduledTransactionId, reversed.schedule.id));

      for (const scheduleId of [paid.schedule.id, reversed.schedule.id]) {
        await expect(
          flowService.editAdjustment(userId, {
            scheduleId,
            description: 'Não deve editar',
            amount: '110.00',
            date: new Date(Date.UTC(2026, 7, 5)),
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
      }
    });
  });

  it('preserves settled discount installments and rejects invalid mode or total changes', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      const { schedule } = await flowService.addDiscount(userId, {
        configId: config.id,
        description: 'Desconto longo',
        amount: '40.00',
        date: new Date(Date.UTC(2026, 6, 10)),
        totalInstallments: 12,
        currentInstallment: 7,
        dueDay: 10,
      });
      const [settled] = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.installmentNumber, 4),
          ),
        );
      await db.update(transactions).set({ isPaid: true }).where(eq(transactions.id, settled.id));

      await flowService.editAdjustment(userId, {
        scheduleId: schedule.id,
        description: 'Desconto longo editado',
        amount: '45.00',
        date: new Date(Date.UTC(2026, 6, 10)),
        totalInstallments: 12,
        currentInstallment: 7,
        dueDay: 10,
      });

      const [preserved] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, settled.id));
      expect(preserved).toMatchObject({ isPaid: true, amount: '40.00' });

      await expect(
        flowService.editAdjustment(userId, {
          scheduleId: schedule.id,
          description: 'Virar único',
          amount: '45.00',
          date: new Date(Date.UTC(2026, 6, 10)),
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      await expect(
        flowService.editAdjustment(userId, {
          scheduleId: schedule.id,
          description: 'Total inválido',
          amount: '45.00',
          date: new Date(Date.UTC(2026, 6, 10)),
          totalInstallments: 3,
          currentInstallment: 3,
          dueDay: 10,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  it('rejects adjustment schedules from another user or an unsupported domain type', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      const fixed = await flowService.addFixedCharge(userId, {
        configId: config.id,
        description: 'Fixo',
        amount: '100.00',
        startDate: new Date(Date.UTC(2026, 6, 1)),
        dueDay: 10,
      });
      const [otherUser] = await db
        .insert(userProfiles)
        .values({ email: 'other-adjustment@test.com', name: 'Other', passwordHash: 'hash' })
        .returning();
      const expense = await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'Gasto',
        amount: '100.00',
        date: new Date(Date.UTC(2026, 6, 1)),
      });

      for (const [ownerId, scheduleId] of [
        [userId, fixed.schedule.id],
        [otherUser.id, expense.schedule.id],
      ]) {
        await expect(
          flowService.editAdjustment(ownerId, {
            scheduleId,
            description: 'Inválido',
            amount: '100.00',
            date: new Date(Date.UTC(2026, 7, 1)),
          }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
    });
  });

  it('edits installment 19/351 with a fixed 12-month materialization horizon', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const { config } = await flowService.createFamilyLoan(userId, { personName: 'Célia' });
      const { schedule } = await flowService.addInstallment(userId, {
        configId: config.id,
        description: 'Financiamento',
        amount: '1531.00',
        totalInstallments: 351,
        currentInstallment: 19,
        dueDay: 10,
        billingMonth: 7,
        billingYear: 2026,
      });

      await expect(
        flowService.editInstallment(userId, {
          scheduleId: schedule.id,
          description: 'Financiamento editado',
          amount: '1531.00',
          totalInstallments: 351,
          currentInstallment: 19,
          currentBillingMonth: 7,
          currentBillingYear: 2026,
        }),
      ).resolves.toMatchObject({ scheduleId: schedule.id });
    });
  });

  it('throws NOT_FOUND when config does not belong to user', async () => {
    await withRollback(async (db) => {
      const { flowService, userId } = await seed(db);
      const [otherUser] = await db
        .insert(userProfiles)
        .values({
          email: 'other@test.com',
          name: 'Other',
          passwordHash: 'hash',
        })
        .returning();

      const { config } = await flowService.createFamilyLoan(otherUser.id, {
        personName: 'Someone',
      });

      await expect(
        flowService.addInstallment(userId, {
          configId: config.id,
          description: 'Test',
          amount: '100.00',
          totalInstallments: 5,
          currentInstallment: 1,
          dueDay: 1,
        }),
      ).rejects.toThrow();
    });
  });

  it('listWithTotals includes outstanding and overdue from the ledger', async () => {
    await withRollback(async (db) => {
      const { flowService, accountService, userId } = await seed(db);
      await accountService.create(userId, { name: 'Itaú', type: 'checking', currency: 'BRL' });
      const { account, config } = await flowService.createFamilyLoan(userId, {
        personName: 'Célia',
      });

      // Charge of 500 in a clearly-past month (Jan 2020) with no payment ⇒ overdue
      // regardless of when the test runs (getLedger uses `now` for currentMonthKey).
      await flowService.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'Cobrança antiga',
        amount: '500.00',
        date: new Date(2020, 0, 15),
        billingMonth: 1,
        billingYear: 2020,
      });

      const now = new Date();
      const results = await flowService.listWithTotals(
        userId,
        now.getMonth() + 1,
        now.getFullYear(),
      );
      const person = results.find((r) => r.account.id === account.id);
      expect(person).toBeDefined();
      expect(person?.overdue).toBeGreaterThan(0);
      expect(person?.outstanding ?? 0).toBeGreaterThanOrEqual(person?.overdue ?? 0);
    });
  });
});
