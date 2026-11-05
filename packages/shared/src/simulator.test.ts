// packages/shared/src/simulator.ts is type-only; this test pins the shapes via `satisfies`.
import { describe, expect, it } from 'vitest';
import type { Frequency } from './enums.ts';
import type {
  InstallmentSuggestion,
  MonthlyAverages,
  MonthRef,
  SimLever,
  SimScenario,
  SpendOutlierMonth,
} from './simulator.ts';

const monthly: Frequency = 'monthly';

const loanPayoff = {
  kind: 'loan_payoff',
  id: 'l1',
  loanAccountId: 'acc-1',
  targetMonth: { month: 8, year: 2026 },
  partialAmount: '1000.00',
} satisfies SimLever;

const incomeChange = {
  kind: 'income_change',
  id: 'l2',
  op: 'add',
  amount: '500.00',
  frequency: monthly,
  fromMonth: { month: 7, year: 2026 },
  toMonth: { month: 12, year: 2026 },
  label: 'Raise',
} satisfies SimLever;

const incomeAdjust = {
  kind: 'income_change',
  id: 'l2b',
  op: 'adjust',
  percent: 10,
  frequency: monthly,
  fromMonth: { month: 7, year: 2026 },
  label: 'Adjust',
} satisfies SimLever;

const oneTime = {
  kind: 'one_time_event',
  id: 'l3',
  sign: 'outflow',
  amount: '2500.00',
  month: { month: 9, year: 2026 },
  label: 'Trip',
} satisfies SimLever;

const recurring = {
  kind: 'recurring_change',
  id: 'l4',
  op: 'add',
  amount: '120.00',
  frequency: monthly,
  startMonth: { month: 7, year: 2026 },
  endMonth: { month: 12, year: 2026 },
  label: 'Gym',
} satisfies SimLever;

const recurringCancel = {
  kind: 'recurring_change',
  id: 'l4b',
  op: 'cancel',
  scheduledTransactionId: 'sched-1',
  label: 'Cancel Netflix',
} satisfies SimLever;

const savings = {
  kind: 'savings_goal',
  id: 'l5',
  target: '20000.00',
  byMonth: { month: 12, year: 2026 },
  label: 'Emergency fund',
} satisfies SimLever;

const averageSpend = {
  kind: 'average_spend',
  id: 'l6',
  amount: '5000.00',
  fromMonth: { month: 6, year: 2026 },
  label: 'Gasto médio',
} satisfies SimLever;

const installmentGrowth = {
  kind: 'installment_growth',
  id: 'l7',
  monthlyAmount: '500.00',
  fromMonth: { month: 6, year: 2026 },
  label: 'Parcela nova/mês',
} satisfies SimLever;

const installmentPlan = {
  kind: 'installment_plan',
  id: 'l8',
  amount: '500.00',
  installments: 12,
  startMonth: { month: 7, year: 2026 },
  label: 'Plano de parcelas',
} satisfies SimLever;

const monthlyAverages = {
  window: 12,
  monthsWithData: 6,
  monthsUsed: 6,
  averageMonthlySpend: '4200.00',
  rawAverageMonthlySpend: '4500.00',
  averageNewInstallment: '350.00',
  byCategory: {
    creditCard: '1800.00',
    loan: '900.00',
    charge: '700.00',
    other: '800.00',
  },
  excludedMonths: [{ month: 5, year: 2026, total: '12000.00', reasons: ['statistical', 'iof'] }],
} satisfies MonthlyAverages;

const installmentSuggestion = {
  label: 'Notebook',
  amount: '500.00',
  installments: 12,
} satisfies InstallmentSuggestion;

const scenario = {
  name: 'What if',
  openingBalanceOverride: '5000.00',
  horizon: 12,
  levers: [
    loanPayoff,
    incomeChange,
    incomeAdjust,
    oneTime,
    recurring,
    recurringCancel,
    savings,
    averageSpend,
    installmentGrowth,
    installmentPlan,
  ],
} satisfies SimScenario;

describe('simulator shared types', () => {
  it('represents a MonthRef', () => {
    const m: MonthRef = { month: 6, year: 2026 };
    expect(m.month).toBe(6);
    expect(m.year).toBe(2026);
  });

  it('builds a SimScenario from every lever kind', () => {
    expect(scenario.levers).toHaveLength(10);
    expect(scenario.levers.map((l) => l.kind)).toEqual([
      'loan_payoff',
      'income_change',
      'income_change',
      'one_time_event',
      'recurring_change',
      'recurring_change',
      'savings_goal',
      'average_spend',
      'installment_growth',
      'installment_plan',
    ]);
    expect(scenario.openingBalanceOverride).toBe('5000.00');
    expect(scenario.horizon).toBe(12);
  });

  it('allows omitting the optional override', () => {
    const minimal: SimScenario = { name: 'Base', horizon: 6, levers: [] };
    expect(minimal.openingBalanceOverride).toBeUndefined();
  });

  it('represents derived MonthlyAverages over the last recorded months', () => {
    expect(monthlyAverages.window).toBe(12);
    expect(monthlyAverages.monthsWithData).toBe(6);
    expect(monthlyAverages.monthsUsed).toBe(6);
    expect(monthlyAverages.averageMonthlySpend).toBe('4200.00');
    expect(monthlyAverages.rawAverageMonthlySpend).toBe('4500.00');
    expect(monthlyAverages.averageNewInstallment).toBe('350.00');
    expect(monthlyAverages.byCategory.creditCard).toBe('1800.00');
    expect(monthlyAverages.byCategory.loan).toBe('900.00');
    expect(monthlyAverages.byCategory.charge).toBe('700.00');
    expect(monthlyAverages.byCategory.other).toBe('800.00');
    const outlier: SpendOutlierMonth = monthlyAverages.excludedMonths[0];
    expect(outlier.reasons).toEqual(['statistical', 'iof']);
  });

  it('represents an InstallmentSuggestion', () => {
    expect(installmentSuggestion.label).toBe('Notebook');
    expect(installmentSuggestion.amount).toBe('500.00');
    expect(installmentSuggestion.installments).toBe(12);
  });
});
