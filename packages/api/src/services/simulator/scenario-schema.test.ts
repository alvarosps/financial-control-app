import type { SimScenario } from '@fc/shared';
import { describe, expect, it } from 'vitest';
import { simScenarioSchema } from './scenario-schema.ts';

describe('simScenarioSchema', () => {
  it('accepts a full scenario with every lever kind', () => {
    const scenario: SimScenario = {
      name: 'Plan A',
      openingBalanceOverride: '1000.00',
      horizon: 12,
      levers: [
        {
          kind: 'loan_payoff',
          id: 'l1',
          loanAccountId: '11111111-1111-1111-1111-111111111111',
          targetMonth: { month: 8, year: 2026 },
          partialAmount: '500.00',
        },
        {
          kind: 'income_change',
          id: 'l2',
          op: 'add',
          amount: '200.00',
          frequency: 'monthly',
          fromMonth: { month: 7, year: 2026 },
          label: 'Side gig',
        },
        {
          kind: 'one_time_event',
          id: 'l3',
          sign: 'outflow',
          amount: '300.00',
          month: { month: 9, year: 2026 },
          label: 'Repair',
        },
        {
          kind: 'recurring_change',
          id: 'l4',
          op: 'cancel',
          scheduledTransactionId: '22222222-2222-2222-2222-222222222222',
          label: 'Drop gym',
        },
        {
          kind: 'savings_goal',
          id: 'l5',
          target: '10000.00',
          byMonth: { month: 12, year: 2026 },
          label: 'Emergency fund',
        },
        {
          kind: 'average_spend',
          id: 'l6',
          amount: '5000.00',
          fromMonth: { month: 6, year: 2026 },
          label: 'Gasto médio',
        },
        {
          kind: 'installment_growth',
          id: 'l7',
          monthlyAmount: '500.00',
          fromMonth: { month: 6, year: 2026 },
          label: 'Parcela nova/mês',
        },
        {
          kind: 'installment_plan',
          id: 'l8',
          amount: '500.00',
          installments: 12,
          startMonth: { month: 7, year: 2026 },
          label: 'Plano de parcelas',
        },
      ],
    };

    const parsed = simScenarioSchema.parse(scenario);
    expect(parsed).toEqual({ ...scenario, version: 2, assumptions: { familyReceiptPercent: 100 } });
  });

  it('rejects an installment_growth lever missing monthlyAmount', () => {
    expect(() =>
      simScenarioSchema.parse({
        name: 'X',
        horizon: 12,
        levers: [
          {
            kind: 'installment_growth',
            id: 'l1',
            fromMonth: { month: 6, year: 2026 },
            label: 'No amount',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects an installment_plan with non-positive installments', () => {
    expect(() =>
      simScenarioSchema.parse({
        name: 'X',
        horizon: 12,
        levers: [
          {
            kind: 'installment_plan',
            id: 'l1',
            amount: '500.00',
            installments: 0,
            startMonth: { month: 7, year: 2026 },
            label: 'No installments',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects an installment_plan with a non-integer installments', () => {
    expect(() =>
      simScenarioSchema.parse({
        name: 'X',
        horizon: 12,
        levers: [
          {
            kind: 'installment_plan',
            id: 'l1',
            amount: '500.00',
            installments: 2.5,
            startMonth: { month: 7, year: 2026 },
            label: 'Fractional installments',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects an average_spend lever with a malformed money string', () => {
    expect(() =>
      simScenarioSchema.parse({
        name: 'X',
        horizon: 12,
        levers: [
          {
            kind: 'average_spend',
            id: 'l1',
            amount: '5000',
            fromMonth: { month: 6, year: 2026 },
            label: 'Bad money',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects an out-of-range horizon', () => {
    expect(() => simScenarioSchema.parse({ name: 'X', horizon: 99, levers: [] })).toThrow();
  });

  it('rejects a malformed money string in a lever amount', () => {
    expect(() =>
      simScenarioSchema.parse({
        name: 'X',
        horizon: 12,
        levers: [
          {
            kind: 'one_time_event',
            id: 'l1',
            sign: 'inflow',
            amount: '12,34',
            month: { month: 6, year: 2026 },
            label: 'bad',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects an unknown lever kind', () => {
    expect(() =>
      simScenarioSchema.parse({ name: 'X', horizon: 12, levers: [{ kind: 'teleport', id: 'l1' }] }),
    ).toThrow();
  });

  describe('income_change per-op required fields', () => {
    const base = { name: 'X', horizon: 12 };

    it('accepts add with amount', () => {
      const result = simScenarioSchema.safeParse({
        ...base,
        levers: [
          {
            kind: 'income_change',
            id: 'l1',
            op: 'add',
            amount: '200.00',
            frequency: 'monthly',
            fromMonth: { month: 7, year: 2026 },
            label: 'Side gig',
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('accepts adjust with percent', () => {
      const result = simScenarioSchema.safeParse({
        ...base,
        levers: [
          {
            kind: 'income_change',
            id: 'l1',
            op: 'adjust',
            amount: '200.00',
            percent: 10,
            frequency: 'monthly',
            fromMonth: { month: 7, year: 2026 },
            label: 'Raise',
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('accepts end with amount and fromMonth', () => {
      const result = simScenarioSchema.safeParse({
        ...base,
        levers: [
          {
            kind: 'income_change',
            id: 'l1',
            op: 'end',
            amount: '700.00',
            frequency: 'monthly',
            fromMonth: { month: 8, year: 2026 },
            label: 'Job ends',
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('rejects add without amount', () => {
      const result = simScenarioSchema.safeParse({
        ...base,
        levers: [
          {
            kind: 'income_change',
            id: 'l1',
            op: 'add',
            frequency: 'monthly',
            fromMonth: { month: 7, year: 2026 },
            label: 'No amount',
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('rejects adjust without percent', () => {
      const result = simScenarioSchema.safeParse({
        ...base,
        levers: [
          {
            kind: 'income_change',
            id: 'l1',
            op: 'adjust',
            amount: '200.00',
            frequency: 'monthly',
            fromMonth: { month: 7, year: 2026 },
            label: 'No percent',
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('rejects adjust with percent but no amount (the percent base, else a no-op)', () => {
      const result = simScenarioSchema.safeParse({
        ...base,
        levers: [
          {
            kind: 'income_change',
            id: 'l1',
            op: 'adjust',
            percent: 10,
            frequency: 'monthly',
            fromMonth: { month: 7, year: 2026 },
            label: 'No amount',
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('rejects end without amount', () => {
      const result = simScenarioSchema.safeParse({
        ...base,
        levers: [
          {
            kind: 'income_change',
            id: 'l1',
            op: 'end',
            frequency: 'monthly',
            fromMonth: { month: 8, year: 2026 },
            label: 'No amount',
          },
        ],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('recurring_change per-op required fields', () => {
    const base = { name: 'X', horizon: 12 };

    it('accepts add with amount and frequency', () => {
      const result = simScenarioSchema.safeParse({
        ...base,
        levers: [
          {
            kind: 'recurring_change',
            id: 'l1',
            op: 'add',
            amount: '60.00',
            frequency: 'quarterly',
            startMonth: { month: 6, year: 2026 },
            label: 'New charge',
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('accepts cancel with scheduledTransactionId', () => {
      const result = simScenarioSchema.safeParse({
        ...base,
        levers: [
          {
            kind: 'recurring_change',
            id: 'l1',
            op: 'cancel',
            scheduledTransactionId: '22222222-2222-2222-2222-222222222222',
            label: 'Drop gym',
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('rejects add without amount', () => {
      const result = simScenarioSchema.safeParse({
        ...base,
        levers: [
          {
            kind: 'recurring_change',
            id: 'l1',
            op: 'add',
            frequency: 'monthly',
            startMonth: { month: 6, year: 2026 },
            label: 'No amount',
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('rejects add without frequency', () => {
      const result = simScenarioSchema.safeParse({
        ...base,
        levers: [
          {
            kind: 'recurring_change',
            id: 'l1',
            op: 'add',
            amount: '60.00',
            startMonth: { month: 6, year: 2026 },
            label: 'No frequency',
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('rejects cancel without scheduledTransactionId', () => {
      const result = simScenarioSchema.safeParse({
        ...base,
        levers: [
          {
            kind: 'recurring_change',
            id: 'l1',
            op: 'cancel',
            label: 'No id',
          },
        ],
      });
      expect(result.success).toBe(false);
    });
  });
});
