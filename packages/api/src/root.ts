import { accountRouter } from './routers/account.router.ts';
import { auditLogRouter } from './routers/audit-log.router.ts';
import { budgetRouter } from './routers/budget.router.ts';
import { categoryRouter } from './routers/category.router.ts';
import { chargesRouter } from './routers/charges.router.ts';
import { creditCardRouter } from './routers/credit-card.router.ts';
import { dashboardRouter } from './routers/dashboard.router.ts';
import { familyLoanRouter } from './routers/family-loan.router.ts';
import { faturaImportRouter } from './routers/fatura-import.router.ts';
import { financialAlertRouter } from './routers/financial-alert.router.ts';
import { incomeRouter } from './routers/income.router.ts';
import { integrationRouter } from './routers/integration.router.ts';
import { loanRouter } from './routers/loan.router.ts';
import { monthlySpendingRouter } from './routers/monthly-spending.router.ts';
import { projectionRouter } from './routers/projection.router.ts';
import { purchaseInboxRouter } from './routers/purchase-inbox.router.ts';
import { scheduledRouter } from './routers/scheduled.router.ts';
import { simulatorRouter } from './routers/simulator.router.ts';
import { transactionRouter } from './routers/transaction.router.ts';
import { router } from './trpc.ts';

export const appRouter = router({
  budget: budgetRouter,
  financialAlert: financialAlertRouter,
  captureDevice: captureDeviceRouter,
  integration: integrationRouter,
  auditLog: auditLogRouter,
  account: accountRouter,
  transaction: transactionRouter,
  scheduled: scheduledRouter,
  creditCard: creditCardRouter,
  category: categoryRouter,
  charges: chargesRouter,
  loan: loanRouter,
  income: incomeRouter,
  dashboard: dashboardRouter,
  familyLoan: familyLoanRouter,
  faturaImport: faturaImportRouter,
  projection: projectionRouter,
  purchaseInbox: purchaseInboxRouter,
  simulator: simulatorRouter,
  monthlySpending: monthlySpendingRouter,
});

export type AppRouter = typeof appRouter;

import { captureDeviceRouter } from './routers/capture-device.router.ts';
