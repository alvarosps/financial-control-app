'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { safeParseFloat } from '@/lib/parse';

type Config = {
  dueDay: number;
  monthlyInterestRate?: string | null;
  annualInterestRate?: string | null;
  originalAmount?: string | null;
  principalAmount?: string | null;
  insurancePaymentDay?: number | null;
  totalInstallments: number;
  currentInstallment?: number | null;
  payoffCalculationType?: string | null;
};

type Props = {
  config: Config;
  total: number;
  current: number;
  insurance: number;
  monthlyRate: number | null;
};

export function LoanDetailsSidebar({ config, total, current, insurance, monthlyRate }: Props) {
  const t = useTranslations();

  return (
    <div>
      <Card surface="glass" className="lg:sticky lg:top-4">
        <CardContent className="pt-5 space-y-4">
          <h2 className="text-lg font-semibold">{t('app-dashboard-loans-id-page.loanDetails')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('app-dashboard-loans-id-page.additionalInformationAboutThis')}
          </p>

          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {t('app-dashboard-loans-id-page.dueDay')}
              </span>
              <span className="font-medium">
                {t('components-loans-detail-loandetailssidebar.dayDay', { day: config.dueDay })}
              </span>
            </div>
            {monthlyRate != null && monthlyRate > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {t('app-dashboard-loans-id-page.monthlyRate')}
                </span>
                <span className="font-medium">{(monthlyRate * 100).toFixed(2)}%</span>
              </div>
            )}
            {config.annualInterestRate && safeParseFloat(config.annualInterestRate) > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {t('app-dashboard-loans-id-page.annualRate')}
                </span>
                <span className="font-medium">
                  {(safeParseFloat(config.annualInterestRate) * 100).toFixed(2)}%
                </span>
              </div>
            )}
            {config.originalAmount && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {t('app-dashboard-loans-id-page.originalAmount')}
                </span>
                <span className="font-medium">
                  {formatCurrency(safeParseFloat(config.originalAmount))}
                </span>
              </div>
            )}
            {config.principalAmount && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {t('app-dashboard-loans-id-page.principalAmount')}
                </span>
                <span className="font-medium">
                  {formatCurrency(safeParseFloat(config.principalAmount))}
                </span>
              </div>
            )}
            {insurance > 0 && config.insurancePaymentDay && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {t('app-dashboard-loans-id-page.insurancePaymentDay')}
                </span>
                <span className="font-medium">
                  {t('components-loans-detail-loandetailssidebar.dayDay', {
                    day: config.insurancePaymentDay,
                  })}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {t('app-dashboard-loans-id-page.totalInstallments')}
              </span>
              <span className="font-medium">{total}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {t('app-dashboard-loans-id-page.currentInstallment')}
              </span>
              <span className="font-medium">{current}</span>
            </div>
            {config.payoffCalculationType && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {t('app-dashboard-loans-id-page.payoffCalculation')}
                </span>
                <span className="font-medium text-right">
                  {config.payoffCalculationType.replace(/_/g, ' ')}
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
