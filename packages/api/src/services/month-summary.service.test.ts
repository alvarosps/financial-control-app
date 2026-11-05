import { accounts, incomeSourceConfigs, transactions, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { FamilyLoanFlowService } from './family-loan-flow.service.ts';
import { MonthSummaryService } from './month-summary.service.ts';

async function seed(db: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const [user] = await db
    .insert(userProfiles)
    .values({ email: 'month-summary@test.com', name: 'Test', passwordHash: 'hash' })
    .returning();

  // Use AccountService.create (sets defaults like currentBalance) instead of raw inserts.
  const accountService = new AccountService(db);
  const checking = await accountService.create(user.id, {
    name: 'Bank',
    type: 'checking',
    currency: 'BRL',
  });
  const card = await accountService.create(user.id, {
    name: 'Card',
    type: 'credit_card',
    currency: 'BRL',
  });
  const revenue = await accountService.create(user.id, {
    name: 'Salary',
    type: 'revenue',
    currency: 'BRL',
  });
  const expense = await accountService.create(user.id, {
    name: 'Cobranças',
    type: 'expense',
    currency: 'BRL',
  });
  const family = await accountService.create(user.id, {
    name: 'João',
    type: 'family_loan',
    currency: 'BRL',
  });
  const loan = await accountService.create(user.id, {
    name: 'Consignado',
    type: 'loan',
    currency: 'BRL',
  });
  const savings = await accountService.create(user.id, {
    name: 'Poupança',
    type: 'savings',
    currency: 'BRL',
  });

  return { userId: user.id, checking, card, revenue, expense, family, loan, savings };
}

describe('MonthSummaryService.getSummary', () => {
  it('aggregates income, family income, cards (by billing month), loans, charges, other', async () => {
    await withRollback(async (db) => {
      const { userId, checking, card, revenue, expense, loan } = await seed(db);
      const jun = new Date(2026, 5, 15); // 2026-06-15

      // Family loan income is derived from the canonical getMonthlyTotal over real
      // configs (not a raw deposit row), so build it through the flow: one-time
      // charge of 300 in June → owed 300.
      const flow = new FamilyLoanFlowService(db);
      const { config: familyConfig } = await flow.createFamilyLoan(userId, { personName: 'João' });
      await flow.addOneTimeCharge(userId, {
        configId: familyConfig.id,
        description: 'Parcela João',
        amount: '300.00',
        date: jun,
        billingMonth: 6,
        billingYear: 2026,
      });

      await db.insert(transactions).values([
        // Income (deposit, income group) by date
        {
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '5000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Salário',
          date: jun,
          domainType: 'income_clt',
        },
        // Card installment counted by BILLING MONTH (date is in May, billing is June)
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '1000.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Parcela cartão',
          date: new Date(2026, 4, 20),
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_installment',
          installmentNumber: 2,
          totalInstallments: 10,
        },
        // Card refund in June billing → reduces card total. Real refunds are
        // type:'withdrawal' with destination = card (see bill.service.test.ts /
        // AddRefundDialog); netting must be by domainType, not transaction type.
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: card.id,
          amount: '100.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Estorno',
          date: jun,
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_refund',
        },
        // Loan payment by date
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: loan.id,
          amount: '700.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Parcela',
          date: jun,
          domainType: 'loan_payment',
          installmentNumber: 5,
          totalInstallments: 48,
        },
        // Fixed charge (recurring_bill) by date
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '200.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Contador',
          date: jun,
          domainType: 'recurring_bill',
        },
        // Uncategorized withdrawal → otherExpenses
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '50.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Avulso legado',
          date: jun,
          domainType: null,
        },
      ]);

      const svc = new MonthSummaryService(db);
      const s = await svc.getSummary(userId, 6, 2026);

      expect(s.income).toBe(5000);
      expect(s.familyLoanIncome).toBe(300);
      expect(s.totalIncome).toBe(5300);
      expect(s.creditCardExpenses).toBe(900); // 1000 - 100 refund, by billing month
      expect(s.loanExpenses).toBe(700);
      expect(s.chargeExpenses).toBe(200);
      expect(s.otherExpenses).toBe(50);
      expect(s.totalExpenses).toBe(1850);
      expect(s.balance).toBe(3450);
    });
  });

  it('familyLoanIncome equals summed getMonthlyTotal (discounts subtracted, payments excluded)', async () => {
    await withRollback(async (db) => {
      // Use this file's seed helper for the user + a BRL checking wallet.
      const { userId, checking } = await seed(db);

      const flow = new FamilyLoanFlowService(db);
      const { config } = await flow.createFamilyLoan(userId, { personName: 'Célia' });
      await flow.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'Charge',
        amount: '300.00',
        date: new Date(2026, 5, 15),
        billingMonth: 6,
        billingYear: 2026,
      });
      await flow.addDiscount(userId, {
        configId: config.id,
        description: 'Desc',
        amount: '100.00',
        date: new Date(2026, 5, 16),
      });
      // A recorded payment must NOT inflate familyLoanIncome (it is settlement, not owed).
      await db
        .update(accounts)
        .set({ openingBalanceAnchorAt: new Date('2020-01-01T00:00:00Z') })
        .where(eq(accounts.id, checking.id));
      await flow.recordPayment(userId, {
        configId: config.id,
        amount: '50.00',
        date: new Date(2026, 5, 17),
        walletAccountId: checking.id,
      });

      const summary = await new MonthSummaryService(db).getSummary(userId, 6, 2026);
      const owed = (await flow.getMonthlyTotal(userId, config.id, 6, 2026)).total;
      expect(summary.familyLoanIncome).toBeCloseTo(owed, 2); // 300 - 100 = 200, payment (50) excluded
      expect(summary.familyLoanIncome).toBeCloseTo(200, 2);
    });
  });

  // Regression: a V1-shaped discount is a TRANSFER (checking → family_loan),
  // not the self-referential deposit that addDiscount creates today. It must be
  // netted ONCE (reducing familyLoanIncome via getMonthlyTotal) and must NOT
  // also land in otherExpenses — otherwise the discount is double-counted in
  // balance. This locks the removal of the old `familyOut` expense term.
  it('does not double-count a V1 family_loan_discount transfer (income nets it; otherExpenses excludes it)', async () => {
    await withRollback(async (db) => {
      const { userId, checking } = await seed(db);

      const flow = new FamilyLoanFlowService(db);
      const { config } = await flow.createFamilyLoan(userId, { personName: 'Célia' });
      await flow.addOneTimeCharge(userId, {
        configId: config.id,
        description: 'Charge',
        amount: '300.00',
        date: new Date(2026, 5, 15),
        billingMonth: 6,
        billingYear: 2026,
      });
      // V1 discount shape: a transfer from the checking wallet INTO the family
      // loan account (addDiscount would instead create a self-referential
      // deposit, which the old familyOut predicate never matched — hence the
      // production-only double-count this test reproduces).
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: config.accountId,
        amount: '100.00',
        currency: 'BRL',
        type: 'transfer',
        description: 'Desconto V1',
        date: new Date(2026, 5, 16),
        domainType: 'family_loan_discount',
      });

      const summary = await new MonthSummaryService(db).getSummary(userId, 6, 2026);
      const owed = (await flow.getMonthlyTotal(userId, config.id, 6, 2026)).total;
      // Income nets the discount exactly once: 300 - 100 = 200.
      expect(summary.familyLoanIncome).toBeCloseTo(owed, 2);
      expect(summary.familyLoanIncome).toBeCloseTo(200, 2);
      // The discount transfer must NOT leak into otherExpenses (no double-count).
      expect(summary.otherExpenses).toBe(0);
      // Balance reflects the discount once: totalIncome 200, no expenses.
      expect(summary.totalIncome).toBeCloseTo(200, 2);
      expect(summary.totalExpenses).toBe(0);
      expect(summary.balance).toBeCloseTo(200, 2);
    });
  });

  it('excludes a card transaction whose date is in the month but billing month is elsewhere', async () => {
    await withRollback(async (db) => {
      const { userId, checking, card } = await seed(db);
      // date in June, billing in July → must NOT count in June summary
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: card.id,
        amount: '999.00',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Parcela',
        date: new Date(2026, 5, 28),
        billingMonth: 7,
        billingYear: 2026,
        domainType: 'credit_card_installment',
      });

      const svc = new MonthSummaryService(db);
      const s = await svc.getSummary(userId, 6, 2026);
      expect(s.creditCardExpenses).toBe(0);
      expect(s.otherExpenses).toBe(0); // card group never falls into other
      expect(s.totalExpenses).toBe(0);
    });
  });

  it('converts non-BRL income (per-transaction rate, then income source config fallback)', async () => {
    await withRollback(async (db) => {
      const { userId, checking } = await seed(db);
      const jun = new Date(2026, 5, 10);

      // USD revenue account: tenancy is via the account (incomeSourceConfigs has no userId).
      const usdRevenue = await new AccountService(db).create(userId, {
        name: 'USD Salary',
        type: 'revenue',
        currency: 'USD',
      });

      // Config fallback rate for the USD source account.
      await db.insert(incomeSourceConfigs).values({
        accountId: usdRevenue.id,
        frequency: 'monthly',
        category: 'salary_pj',
        exchangeRate: '5.40',
      });

      await db.insert(transactions).values([
        // USD income with a per-transaction rate (5.00) → wins over the config (5.40).
        {
          userId,
          sourceAccountId: usdRevenue.id,
          destinationAccountId: checking.id,
          amount: '1000.00',
          currency: 'USD',
          type: 'deposit',
          description: 'Salário PJ',
          date: jun,
          domainType: 'income_pj',
          exchangeRate: '5.00',
        },
        // USD income without a per-transaction rate → falls back to the config (5.40).
        {
          userId,
          sourceAccountId: usdRevenue.id,
          destinationAccountId: checking.id,
          amount: '200.00',
          currency: 'USD',
          type: 'deposit',
          description: 'Extra PJ',
          date: jun,
          domainType: 'income_pj',
        },
      ]);

      const svc = new MonthSummaryService(db);
      const s = await svc.getSummary(userId, 6, 2026);

      // 1000 * 5.00 + 200 * 5.40 = 5000 + 1080 = 6080
      expect(s.income).toBe(6080);
      expect(s.totalIncome).toBe(6080);
      expect(s.balance).toBe(6080);
    });
  });

  it('reports an incomplete subtotal when non-BRL income has no per-tx rate and no income source config rate', async () => {
    await withRollback(async (db) => {
      const { userId, checking } = await seed(db);
      const jun = new Date(2026, 5, 10);

      const usdRevenue = await new AccountService(db).create(userId, {
        name: 'USD Salary',
        type: 'revenue',
        currency: 'USD',
      });

      // No incomeSourceConfigs row for this account, and no per-tx exchangeRate.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: usdRevenue.id,
        destinationAccountId: checking.id,
        amount: '1000.00',
        currency: 'USD',
        type: 'deposit',
        description: 'Salário PJ sem taxa',
        date: jun,
        domainType: 'income_pj',
      });

      const svc = new MonthSummaryService(db);
      expect(await svc.getSummary(userId, 6, 2026)).toMatchObject({
        income: 0,
        incomeUnavailableCount: 1,
      });
    });
  });

  it('reports an incomplete subtotal when non-BRL income has a zero per-tx exchange rate', async () => {
    await withRollback(async (db) => {
      const { userId, checking } = await seed(db);
      const jun = new Date(2026, 5, 10);

      const usdRevenue = await new AccountService(db).create(userId, {
        name: 'USD Salary',
        type: 'revenue',
        currency: 'USD',
      });

      await db.insert(transactions).values({
        userId,
        sourceAccountId: usdRevenue.id,
        destinationAccountId: checking.id,
        amount: '1000.00',
        currency: 'USD',
        type: 'deposit',
        description: 'Salário PJ taxa zero',
        date: jun,
        domainType: 'income_pj',
        exchangeRate: '0',
      });

      const svc = new MonthSummaryService(db);
      expect(await svc.getSummary(userId, 6, 2026)).toMatchObject({
        income: 0,
        incomeUnavailableCount: 1,
      });
    });
  });

  it('reports an incomplete subtotal when non-BRL income has a negative per-tx exchange rate', async () => {
    await withRollback(async (db) => {
      const { userId, checking } = await seed(db);
      const jun = new Date(2026, 5, 10);

      const usdRevenue = await new AccountService(db).create(userId, {
        name: 'USD Salary',
        type: 'revenue',
        currency: 'USD',
      });

      await db.insert(transactions).values({
        userId,
        sourceAccountId: usdRevenue.id,
        destinationAccountId: checking.id,
        amount: '1000.00',
        currency: 'USD',
        type: 'deposit',
        description: 'Salário PJ taxa negativa',
        date: jun,
        domainType: 'income_pj',
        exchangeRate: '-5.00',
      });

      const svc = new MonthSummaryService(db);
      expect(await svc.getSummary(userId, 6, 2026)).toMatchObject({
        income: 0,
        incomeUnavailableCount: 1,
      });
    });
  });

  it('counts a NULL-billingMonth card expense in otherExpenses (no orphaned money)', async () => {
    await withRollback(async (db) => {
      const { userId, checking, card } = await seed(db);
      const jun = new Date(2026, 5, 18);

      // credit_card group withdrawal whose date is in June but with NULL billing
      // month/year. It must NOT vanish: counted in otherExpenses, not in cards.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: card.id,
        amount: '123.45',
        currency: 'BRL',
        type: 'withdrawal',
        description: 'Despesa cartão sem fatura',
        date: jun,
        billingMonth: null,
        billingYear: null,
        domainType: 'credit_card_expense',
      });

      const svc = new MonthSummaryService(db);
      const s = await svc.getSummary(userId, 6, 2026);

      expect(s.creditCardExpenses).toBe(0);
      expect(s.otherExpenses).toBe(123.45);
      expect(s.totalExpenses).toBe(123.45);
    });
  });

  // The `date` column is UTC-midnight, so the month window is built with
  // Date.UTC boundaries. This proves both edges (the 1st and the last day) land
  // in the month, and that adjacent-month rows are excluded — no off-by-one in
  // UTC−3. Mirrors the daily-control boundary test for calendar consistency.
  it('includes income on the FIRST and expense on the LAST day; excludes adjacent months', async () => {
    await withRollback(async (db) => {
      const { userId, checking, revenue, expense } = await seed(db);

      await db.insert(transactions).values([
        // Income on the FIRST day of June → counts.
        {
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '5000.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Salário dia 1',
          date: new Date(Date.UTC(2026, 5, 1)),
          domainType: 'income_clt',
        },
        // Expense on the LAST day of June (June has 30 days) → counts.
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '200.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Cobrança dia 30',
          date: new Date(Date.UTC(2026, 5, 30)),
          domainType: 'recurring_bill',
        },
        // Last day of the PREVIOUS month (May 31) → must NOT count in June.
        {
          userId,
          sourceAccountId: revenue.id,
          destinationAccountId: checking.id,
          amount: '999.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Maio 31',
          date: new Date(Date.UTC(2026, 4, 31)),
          domainType: 'income_clt',
        },
        // First day of the NEXT month (July 1) → must NOT count in June.
        {
          userId,
          sourceAccountId: checking.id,
          destinationAccountId: expense.id,
          amount: '888.00',
          currency: 'BRL',
          type: 'withdrawal',
          description: 'Julho 1',
          date: new Date(Date.UTC(2026, 6, 1)),
          domainType: 'recurring_bill',
        },
      ]);

      const svc = new MonthSummaryService(db);
      const s = await svc.getSummary(userId, 6, 2026);

      expect(s.income).toBe(5000); // first-day income in, adjacent months out
      expect(s.chargeExpenses).toBe(200); // last-day charge in, adjacent months out
      expect(s.totalIncome).toBe(5000);
      expect(s.totalExpenses).toBe(200);
    });
  });

  // All three query methods (the grouped date-window query,
  // cardExpensesByBillingMonth, and nullBillingCardExpenses) filter
  // isReversed=false AND reversesTransactionId IS NULL. A reversed original and
  // its reversal row must BOTH drop out of every bucket so the pair nets to zero
  // and never inflates income/expenses/balance. Lock both halves.
  it('excludes both a reversed original and its reversal row from all buckets', async () => {
    await withRollback(async (db) => {
      const { userId, checking, revenue, expense, card } = await seed(db);
      const jun = new Date(2026, 5, 15);

      // A surviving income deposit so the buckets are non-trivially populated.
      await db.insert(transactions).values({
        userId,
        sourceAccountId: revenue.id,
        destinationAccountId: checking.id,
        amount: '5000.00',
        currency: 'BRL',
        type: 'deposit',
        description: 'Salário',
        date: jun,
        domainType: 'income_clt',
      });

      // Reversed ORIGINALS (isReversed=true). reversesTransactionId is a self-FK,
      // so each reversal row must point at a real original id — insert originals
      // first, then their reversal rows. One original per query method:
      //  - charge (date-window grouped query)
      //  - card installment in billing month (cardExpensesByBillingMonth)
      //  - NULL-billing card expense in window (nullBillingCardExpenses)
      const originals = await db
        .insert(transactions)
        .values([
          {
            userId,
            sourceAccountId: checking.id,
            destinationAccountId: expense.id,
            amount: '400.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'Cobrança estornada',
            date: jun,
            domainType: 'recurring_bill',
            isReversed: true,
          },
          {
            userId,
            sourceAccountId: checking.id,
            destinationAccountId: card.id,
            amount: '900.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'Parcela estornada',
            date: jun,
            billingMonth: 6,
            billingYear: 2026,
            domainType: 'credit_card_installment',
            isReversed: true,
          },
          {
            userId,
            sourceAccountId: checking.id,
            destinationAccountId: card.id,
            amount: '50.00',
            currency: 'BRL',
            type: 'withdrawal',
            description: 'Despesa cartão sem fatura estornada',
            date: jun,
            billingMonth: null,
            billingYear: null,
            domainType: 'credit_card_expense',
            isReversed: true,
          },
        ])
        .returning({ id: transactions.id });

      // The REVERSAL rows (reversesTransactionId set, isReversed=false) → also out.
      await db.insert(transactions).values([
        {
          userId,
          sourceAccountId: expense.id,
          destinationAccountId: checking.id,
          amount: '400.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Estorno da cobrança',
          date: jun,
          domainType: 'recurring_bill',
          reversesTransactionId: originals[0].id,
        },
        {
          userId,
          sourceAccountId: card.id,
          destinationAccountId: checking.id,
          amount: '900.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Estorno parcela',
          date: jun,
          billingMonth: 6,
          billingYear: 2026,
          domainType: 'credit_card_installment',
          reversesTransactionId: originals[1].id,
        },
        {
          userId,
          sourceAccountId: card.id,
          destinationAccountId: checking.id,
          amount: '50.00',
          currency: 'BRL',
          type: 'deposit',
          description: 'Estorno despesa cartão sem fatura',
          date: jun,
          billingMonth: null,
          billingYear: null,
          domainType: 'credit_card_expense',
          reversesTransactionId: originals[2].id,
        },
      ]);

      const svc = new MonthSummaryService(db);
      const s = await svc.getSummary(userId, 6, 2026);

      // Only the surviving income remains; every reversed/reversal pair nets out.
      expect(s.income).toBe(5000);
      expect(s.totalIncome).toBe(5000);
      expect(s.creditCardExpenses).toBe(0);
      expect(s.chargeExpenses).toBe(0);
      expect(s.otherExpenses).toBe(0);
      expect(s.totalExpenses).toBe(0);
      expect(s.balance).toBe(5000);
    });
  });

  // An inter-account transfer (checking → savings) is type:'transfer' with a
  // NULL domainType: pure money movement, never an expense or income. It must
  // contribute 0 to every bucket — not leak into otherExpenses (which only
  // catches type:'withdrawal') nor anywhere else.
  it('does not count a checking→savings transfer in any bucket', async () => {
    await withRollback(async (db) => {
      const { userId, checking, savings } = await seed(db);
      const jun = new Date(2026, 5, 12);

      await db.insert(transactions).values({
        userId,
        sourceAccountId: checking.id,
        destinationAccountId: savings.id,
        amount: '2000.00',
        currency: 'BRL',
        type: 'transfer',
        description: 'Aplicação poupança',
        date: jun,
        domainType: null,
      });

      const svc = new MonthSummaryService(db);
      const s = await svc.getSummary(userId, 6, 2026);

      expect(s.income).toBe(0);
      expect(s.otherExpenses).toBe(0);
      expect(s.totalExpenses).toBe(0);
      expect(s.balance).toBe(0);
    });
  });
});
