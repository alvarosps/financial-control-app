/**
 * A single tRPC react-query procedure slice — only the `invalidate` action this
 * helper needs. The real `trpc.useUtils()` procedures expose an `invalidate`
 * with all-optional parameters returning `Promise<void>`, so they structurally
 * satisfy this minimal shape (interface segregation / DIP): callers pass the
 * full utils object, tests pass a tiny stub, and neither needs a cast.
 */
type InvalidatableProcedure = { invalidate: () => Promise<void> };

/** Financial changes affect cross-domain forecasts, cash, review and statements. */
export function invalidateFinancialPosition(utils: InvalidatableProcedure) {
  return utils.invalidate();
}

/**
 * The minimal slice of `trpc.useUtils()` that {@link invalidateCreditCardContext}
 * touches. Typing the parameter against this structural interface (instead of
 * the huge nominal `ReturnType<typeof trpc.useUtils>`) lets a hermetic test stub
 * satisfy it directly, and the full utils object still passes since it is a
 * structural superset.
 */
export interface CreditCardInvalidationUtils {
  purchaseInbox: InvalidatableProcedure;
  monthlySpending: { get: InvalidatableProcedure };
  projection: { get12Months: InvalidatableProcedure };
  transaction: { list: InvalidatableProcedure };
  scheduled: {
    list: InvalidatableProcedure;
    getById: InvalidatableProcedure;
  };
  creditCard: {
    getBill: InvalidatableProcedure;
    getBillSummary: InvalidatableProcedure;
    getConsolidatedBill: InvalidatableProcedure;
    getBillHistory: InvalidatableProcedure;
    getConfig: InvalidatableProcedure;
    listConfigs: InvalidatableProcedure;
  };
  account: {
    list: InvalidatableProcedure;
    getById: InvalidatableProcedure;
  };
  dashboard: {
    monthlySummary: InvalidatableProcedure;
    dailyControl: InvalidatableProcedure;
    upcomingItems: InvalidatableProcedure;
  };
}

/**
 * Invalidate every cached query that can be affected by a credit-card
 * mutation (paying a bill, adding/editing an expense or installment, issuing
 * a refund, …).
 *
 * Callers should `await` this in their mutation's `onSuccess` so the UI
 * refetches consistently instead of each dialog drifting its own
 * invalidation set.
 */
export function invalidateCreditCardContext(utils: CreditCardInvalidationUtils) {
  return Promise.all([
    utils.purchaseInbox.invalidate(),
    utils.monthlySpending.get.invalidate(),
    utils.projection.get12Months.invalidate(),
    utils.transaction.list.invalidate(),
    utils.scheduled.list.invalidate(),
    utils.scheduled.getById.invalidate(),
    utils.creditCard.getBill.invalidate(),
    utils.creditCard.getBillSummary.invalidate(),
    utils.creditCard.getConsolidatedBill.invalidate(),
    utils.creditCard.getBillHistory.invalidate(),
    utils.creditCard.getConfig.invalidate(),
    utils.creditCard.listConfigs.invalidate(),
    utils.account.list.invalidate(),
    utils.account.getById.invalidate(),
    utils.dashboard.monthlySummary.invalidate(),
    // Paying/editing a card changes fatura paid-state and due-date placement,
    // which the daily-control calendar and the upcoming panel both surface.
    utils.dashboard.dailyControl.invalidate(),
    utils.dashboard.upcomingItems.invalidate(),
  ]);
}

export interface ChargeInvalidationUtils {
  charges: { list: InvalidatableProcedure };
  dashboard: {
    monthlySummary: InvalidatableProcedure;
    dailyControl: InvalidatableProcedure;
    upcomingItems: InvalidatableProcedure;
  };
}

export function invalidateChargeContext(utils: ChargeInvalidationUtils) {
  return Promise.all([
    utils.charges.list.invalidate(),
    utils.dashboard.monthlySummary.invalidate(),
    utils.dashboard.dailyControl.invalidate(),
    utils.dashboard.upcomingItems.invalidate(),
  ]);
}

export interface IncomeInvalidationUtils {
  income: { list: InvalidatableProcedure };
  dashboard: { monthlySummary: InvalidatableProcedure };
}

export function invalidateIncomeContext(utils: IncomeInvalidationUtils) {
  return Promise.all([utils.income.list.invalidate(), utils.dashboard.monthlySummary.invalidate()]);
}

export interface LoanInvalidationUtils {
  loan: { list: InvalidatableProcedure };
  dashboard: { monthlySummary: InvalidatableProcedure };
}

export function invalidateLoanContext(utils: LoanInvalidationUtils) {
  return Promise.all([utils.loan.list.invalidate(), utils.dashboard.monthlySummary.invalidate()]);
}

export interface QuickAddInvalidationUtils {
  transaction: { list: InvalidatableProcedure };
  account: {
    list: InvalidatableProcedure;
    walletsOverview: InvalidatableProcedure;
  };
  dashboard: {
    monthlySummary: InvalidatableProcedure;
    dailyControl: InvalidatableProcedure;
    upcomingItems: InvalidatableProcedure;
  };
  monthlySpending: { get: InvalidatableProcedure };
}

export function invalidateQuickAddContext(utils: QuickAddInvalidationUtils) {
  return Promise.all([
    utils.transaction.list.invalidate(),
    utils.account.list.invalidate(),
    utils.account.walletsOverview.invalidate(),
    utils.dashboard.monthlySummary.invalidate(),
    utils.dashboard.dailyControl.invalidate(),
    utils.dashboard.upcomingItems.invalidate(),
    utils.monthlySpending.get.invalidate(),
  ]);
}
