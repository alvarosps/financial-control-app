'use client';

import type { SavingsGoal } from '@fc/domain';
import type { MonthRef } from '@fc/shared';
import { useLocale, useTranslations } from 'next-intl';
import { StatCard } from '@/components/shared/StatCard';
import { formatCurrency } from '@/lib/format';
import { monthYearLabel } from '@/lib/labels';

export type SimulatorKpisProps = {
  kpis: {
    openingNow: number;
    endingBaseline: number;
    endingSimulated: number;
    delta: number;
  };
  firstOverdraft: MonthRef | null;
  savingsGoal?: SavingsGoal;
};

export function SimulatorKpis({ kpis, firstOverdraft, savingsGoal }: SimulatorKpisProps) {
  const locale = useLocale();
  const t = useTranslations();
  const overdraftLabel = firstOverdraft
    ? monthYearLabel(firstOverdraft, 4, locale)
    : t('simulator.kpis.noOverdraft');

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <StatCard
        surface="glass"
        label={t('simulator.kpis.openingNow')}
        value={formatCurrency(kpis.openingNow)}
        tone={kpis.openingNow >= 0 ? 'income' : 'expense'}
      />
      <StatCard
        surface="glass"
        label={t('simulator.kpis.endingBaseline')}
        value={formatCurrency(kpis.endingBaseline)}
        tone={kpis.endingBaseline >= 0 ? 'income' : 'expense'}
      />
      <StatCard
        surface="glass"
        label={t('simulator.kpis.endingSimulated')}
        value={formatCurrency(kpis.endingSimulated)}
        tone={kpis.endingSimulated >= 0 ? 'income' : 'expense'}
      />
      <StatCard
        surface="glass"
        label={t('simulator.kpis.delta')}
        value={formatCurrency(kpis.delta)}
        tone={kpis.delta >= 0 ? 'income' : 'expense'}
        delta={{
          label: formatCurrency(kpis.delta),
          direction: kpis.delta > 0 ? 'up' : kpis.delta < 0 ? 'down' : 'neutral',
        }}
      />
      <StatCard
        surface="glass"
        label={t('simulator.kpis.firstOverdraft')}
        value={overdraftLabel}
        tone={firstOverdraft ? 'expense' : 'income'}
      />
      {savingsGoal && (
        <StatCard
          surface="glass"
          label={t('simulator.kpis.savingsGoalRequired')}
          value={formatCurrency(savingsGoal.requiredMonthly)}
          tone={savingsGoal.feasible ? 'income' : 'expense'}
          delta={{
            label: savingsGoal.feasible
              ? t('simulator.kpis.savingsGoalFeasible')
              : t('simulator.kpis.savingsGoalNotFeasible'),
            direction: savingsGoal.feasible ? 'up' : 'down',
          }}
        />
      )}
    </div>
  );
}
