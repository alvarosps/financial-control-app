'use client';

import { useLocale, useTranslations } from 'next-intl';
import { ProgressMeter } from '@/components/shared/ProgressMeter';
import { StatCard } from '@/components/shared/StatCard';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { getMonthName } from '@/lib/labels';

type Props = {
  current: number;
  total: number;
  paid: number;
  remaining: number;
  pct: number;
  monthlyPayment: number;
  insurance: number;
  totalMonthly: number;
  totalRemaining: number;
};

export function LoanBalanceSummary({
  total,
  paid,
  remaining,
  monthlyPayment,
  insurance,
  totalMonthly,
  totalRemaining,
}: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const now = new Date();
  const currentMonthName = getMonthName(now.getMonth() + 1, locale);
  const currentYear = now.getFullYear();

  return (
    <Card>
      <CardContent className="pt-5 space-y-5">
        <h2 className="text-lg font-semibold">
          {t('components-loans-detail-loanbalancesummary.paymentProgress')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t('components-loans-detail-loanbalancesummary.trackYourLoanProgress')}
        </p>

        {/* Período Atual */}
        <div className="flex items-center justify-between rounded-lg bg-surface-elevated px-4 py-3">
          <div>
            <p className="text-xs text-muted-foreground">
              {t('components-loans-detail-loanbalancesummary.currentPeriod')}
            </p>
            <p className="text-base font-semibold">
              {currentMonthName} {currentYear}
            </p>
          </div>
          <Badge variant="warning">{t('components-loans-detail-loanbalancesummary.pending')}</Badge>
        </div>

        {/* Progress */}
        <ProgressMeter
          current={paid}
          total={total}
          label={`${paid} ${t('components-loans-detail-loanbalancesummary.of')} ${total}`}
        />

        {/* Payment values */}
        <div className={insurance > 0 ? 'grid grid-cols-2 gap-4' : 'grid grid-cols-1 gap-4'}>
          <StatCard
            label={t('components-loans-detail-loanbalancesummary.monthlyInstallment')}
            value={formatCurrency(monthlyPayment)}
            tone="neutral"
          />
          {insurance > 0 && (
            <StatCard
              label={t('components-loans-detail-loanbalancesummary.insurance')}
              value={formatCurrency(insurance)}
              tone="neutral"
            />
          )}
        </div>

        {insurance > 0 && (
          <StatCard
            label={t('components-loans-detail-loanbalancesummary.monthlyTotal')}
            value={formatCurrency(totalMonthly)}
            tone="expense"
          />
        )}

        <StatCard
          label={t('components-loans-detail-loanbalancesummary.remainingTotal')}
          value={formatCurrency(totalRemaining)}
          tone="neutral"
        />

        {/* Pago / Restante / Status */}
        <div className="grid grid-cols-3 gap-4">
          <StatCard
            label={t('components-loans-detail-loanbalancesummary.paid')}
            value={paid}
            tone="income"
          />
          <StatCard
            label={t('components-loans-detail-loanbalancesummary.remaining')}
            value={remaining}
            tone="neutral"
          />
          <StatCard
            label={t('components-loans-detail-loanbalancesummary.status')}
            value={
              <Badge variant="income">
                {t('components-loans-detail-loanbalancesummary.active')}
              </Badge>
            }
            tone="neutral"
          />
        </div>
      </CardContent>
    </Card>
  );
}
