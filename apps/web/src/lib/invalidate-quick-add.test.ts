import { describe, expect, it } from 'vitest';
import { invalidateQuickAddContext, type QuickAddInvalidationUtils } from './invalidate';

function makeCounter() {
  const calls: string[] = [];
  const procedure = (name: string) => ({
    invalidate: () => {
      calls.push(name);
      return Promise.resolve();
    },
  });
  return { calls, procedure };
}

describe('invalidateQuickAddContext', () => {
  it('invalidates every wallet expense cache context', async () => {
    const { calls, procedure } = makeCounter();
    const utils: QuickAddInvalidationUtils = {
      transaction: { list: procedure('transaction.list') },
      account: {
        list: procedure('account.list'),
        walletsOverview: procedure('account.walletsOverview'),
      },
      dashboard: {
        monthlySummary: procedure('dashboard.monthlySummary'),
        dailyControl: procedure('dashboard.dailyControl'),
        upcomingItems: procedure('dashboard.upcomingItems'),
      },
      monthlySpending: { get: procedure('monthlySpending.get') },
    };

    await invalidateQuickAddContext(utils);

    expect(calls.sort()).toEqual([
      'account.list',
      'account.walletsOverview',
      'dashboard.dailyControl',
      'dashboard.monthlySummary',
      'dashboard.upcomingItems',
      'monthlySpending.get',
      'transaction.list',
    ]);
  });
});
