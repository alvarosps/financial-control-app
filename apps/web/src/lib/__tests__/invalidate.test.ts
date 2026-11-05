import { describe, expect, it, type Mock, vi } from 'vitest';
import {
  type ChargeInvalidationUtils,
  type CreditCardInvalidationUtils,
  type IncomeInvalidationUtils,
  invalidateChargeContext,
  invalidateCreditCardContext,
  invalidateIncomeContext,
  invalidateLoanContext,
  type LoanInvalidationUtils,
} from '../invalidate';

type ProcedureStub = { invalidate: Mock };

function makeProc(): ProcedureStub {
  return { invalidate: vi.fn().mockResolvedValue(undefined) };
}

/**
 * invalidateCreditCardContext is an external-boundary helper: it calls into
 * tRPC's react-query utils (which is itself a facade over the QueryClient
 * cache). This test verifies the helper hits *exactly* the canonical
 * eleven-query set documented on the function — regressions that silently drop
 * one of the invalidations are the kind of bug that's otherwise painful to
 * catch (stale UI after a mutation).
 */
describe('invalidateCreditCardContext', () => {
  it('invalidates financial projections and the purchase inbox with card queries', async () => {
    const utilsStub = {
      purchaseInbox: makeProc(),
      monthlySpending: { get: makeProc() },
      projection: { get12Months: makeProc() },
      transaction: { list: makeProc() },
      scheduled: { list: makeProc(), getById: makeProc() },
      creditCard: {
        getBill: makeProc(),
        getBillSummary: makeProc(),
        getConsolidatedBill: makeProc(),
        getBillHistory: makeProc(),
        getConfig: makeProc(),
        listConfigs: makeProc(),
      },
      account: { list: makeProc(), getById: makeProc() },
      dashboard: {
        monthlySummary: makeProc(),
        dailyControl: makeProc(),
        upcomingItems: makeProc(),
      },
    } satisfies CreditCardInvalidationUtils;

    await invalidateCreditCardContext(utilsStub);

    expect(utilsStub.purchaseInbox.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.monthlySpending.get.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.projection.get12Months.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.transaction.list.invalidate).toHaveBeenCalledTimes(1);

    expect(utilsStub.scheduled.list.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.scheduled.getById.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.creditCard.getBill.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.creditCard.getBillSummary.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.creditCard.getConsolidatedBill.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.creditCard.getBillHistory.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.creditCard.getConfig.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.creditCard.listConfigs.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.account.list.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.account.getById.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.dashboard.monthlySummary.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.dashboard.dailyControl.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.dashboard.upcomingItems.invalidate).toHaveBeenCalledTimes(1);
  });

  it('resolves after every invalidation settles (Promise.all semantics)', async () => {
    let countResolved = 0;
    const slow = (): ProcedureStub => ({
      invalidate: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              countResolved += 1;
              resolve();
            }, 1);
          }),
      ),
    });

    const utilsStub = {
      purchaseInbox: slow(),
      monthlySpending: { get: slow() },
      projection: { get12Months: slow() },
      transaction: { list: slow() },
      scheduled: { list: slow(), getById: slow() },
      creditCard: {
        getBill: slow(),
        getBillSummary: slow(),
        getConsolidatedBill: slow(),
        getBillHistory: slow(),
        getConfig: slow(),
        listConfigs: slow(),
      },
      account: { list: slow(), getById: slow() },
      dashboard: { monthlySummary: slow(), dailyControl: slow(), upcomingItems: slow() },
    } satisfies CreditCardInvalidationUtils;

    await invalidateCreditCardContext(utilsStub);
    expect(countResolved).toBe(17);
  });
});

describe('invalidateChargeContext', () => {
  it('invalidates the canonical 4-query charge set', async () => {
    const utilsStub = {
      charges: { list: makeProc() },
      dashboard: {
        monthlySummary: makeProc(),
        dailyControl: makeProc(),
        upcomingItems: makeProc(),
      },
    } satisfies ChargeInvalidationUtils;
    await invalidateChargeContext(utilsStub);
    expect(utilsStub.charges.list.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.dashboard.monthlySummary.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.dashboard.dailyControl.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.dashboard.upcomingItems.invalidate).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateIncomeContext', () => {
  it('invalidates income.list and dashboard.monthlySummary', async () => {
    const utilsStub = {
      income: { list: makeProc() },
      dashboard: { monthlySummary: makeProc() },
    } satisfies IncomeInvalidationUtils;
    await invalidateIncomeContext(utilsStub);
    expect(utilsStub.income.list.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.dashboard.monthlySummary.invalidate).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateLoanContext', () => {
  it('invalidates loan.list and dashboard.monthlySummary', async () => {
    const utilsStub = {
      loan: { list: makeProc() },
      dashboard: { monthlySummary: makeProc() },
    } satisfies LoanInvalidationUtils;
    await invalidateLoanContext(utilsStub);
    expect(utilsStub.loan.list.invalidate).toHaveBeenCalledTimes(1);
    expect(utilsStub.dashboard.monthlySummary.invalidate).toHaveBeenCalledTimes(1);
  });
});
