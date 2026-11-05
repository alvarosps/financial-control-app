'use client';

import { useTranslations } from 'next-intl';
import { PayoffMeter } from '@/components/shared/PayoffMeter';
import { StatCard } from '@/components/shared/StatCard';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';

type Monthly = {
  total: number;
  borrowedCardTotal: number;
  installments: number;
  fixedCharges: number;
  oneTimeCharges: number;
  discounts: number;
};

type Props = {
  monthly: Monthly;
  cardCount: number;
};

export function FamilyLoanBalanceSummary({ monthly, cardCount }: Props) {
  const t = useTranslations();
  return (
    <>
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          surface="glass"
          tone="income"
          label={t('components-family-loans-detail-familyloanbalancesummary.monthlyTotal')}
          value={formatCurrency(monthly.total)}
        />
        <StatCard
          surface="glass"
          tone="neutral"
          label={t('components-family-loans-detail-familyloanbalancesummary.cards')}
          value={formatCurrency(monthly.borrowedCardTotal)}
          delta={{
            label: `${cardCount} ${t('components-family-loans-detail-familyloanbalancesummary.cardS')}`,
            direction: 'neutral',
          }}
        />
        <StatCard
          surface="glass"
          tone="neutral"
          label={t('components-family-loans-detail-familyloanbalancesummary.installments')}
          value={formatCurrency(monthly.installments)}
        />
        <StatCard
          surface="glass"
          tone="expense"
          label={t('components-family-loans-detail-familyloanbalancesummary.discounts')}
          value={`-${formatCurrency(monthly.discounts)}`}
        />
      </div>

      {/* Cálculo Mensal */}
      <Card surface="glass">
        <CardContent className="pt-5 space-y-4">
          <div>
            <h2 className="text-lg font-semibold">
              {t('components-family-loans-detail-familyloanbalancesummary.monthlyCalculation')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t(
                'components-family-loans-detail-familyloanbalancesummary.formulaInstallmentsCardsFixed',
              )}
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="rounded-lg bg-surface-elevated p-3 text-center">
              <p className="text-xs text-muted-foreground">
                {t('components-family-loans-detail-familyloanbalancesummary.installments')}
              </p>
              <p className="font-bold">{formatCurrency(monthly.installments)}</p>
            </div>
            <div className="rounded-lg bg-surface-elevated p-3 text-center">
              <p className="text-xs text-muted-foreground">
                {t('components-family-loans-detail-familyloanbalancesummary.cards')}
              </p>
              <p className="font-bold">{formatCurrency(monthly.borrowedCardTotal)}</p>
            </div>
            <div className="rounded-lg bg-surface-elevated p-3 text-center">
              <p className="text-xs text-muted-foreground">
                {t('components-family-loans-detail-familyloanbalancesummary.fixed')}
              </p>
              <p className="font-bold">{formatCurrency(monthly.fixedCharges)}</p>
            </div>
            <div className="rounded-lg bg-surface-elevated p-3 text-center">
              <p className="text-xs text-muted-foreground">
                {t('components-family-loans-detail-familyloanbalancesummary.oneTimeCharges')}
              </p>
              <p className="font-bold">{formatCurrency(monthly.oneTimeCharges)}</p>
            </div>
            <div className="rounded-lg bg-expense/10 p-3 text-center">
              <p className="text-xs text-expense">
                {t('components-family-loans-detail-familyloanbalancesummary.discounts')}
              </p>
              <p className="font-bold text-expense">-{formatCurrency(monthly.discounts)}</p>
            </div>
          </div>

          <PayoffMeter
            label={t('components-family-loans-detail-familyloanbalancesummary.monthlyTotal')}
            amount={formatCurrency(monthly.total)}
          />
        </CardContent>
      </Card>
    </>
  );
}
