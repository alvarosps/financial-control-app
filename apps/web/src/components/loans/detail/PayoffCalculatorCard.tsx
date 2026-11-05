'use client';

import { Money } from '@fc/domain';
import { useTranslations } from 'next-intl';
import { PayoffMeter } from '@/components/shared/PayoffMeter';
import { StatCard } from '@/components/shared/StatCard';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency, formatPercent } from '@/lib/format';
import { getLoanTypeLabel } from '@/lib/labels';

type Payoff = {
  totalIfPaying: string;
  outstandingBalance: string;
  savings: string;
  savingsPercent: number;
  annualCet: { rate: string; source: string | null; observedOn: string | null } | null;
  monthlyNominalRate: string;
  payoffQuote: {
    status: 'missing' | 'future' | 'expired' | 'valid';
    quotedAmount: string | null;
    source: string | null;
    quotedOn: string | null;
    validUntil: string | null;
  };
  monthlyRelease: string;
  payrollRelease: string;
  bankRelease: string;
  economicResponsibility: 'unknown' | 'own' | 'family' | 'work' | 'property';
  cashReady: boolean;
  availableCash: string | null;
  exceedsAvailableCash: boolean | null;
};

type Props = {
  payoff: Payoff;
  loanType?: string | null;
  totalRemaining: number;
};

export function PayoffCalculatorCard({ payoff, loanType, totalRemaining }: Props) {
  const t = useTranslations();
  return (
    <Card>
      <CardContent className="pt-5 space-y-4">
        <h2 className="text-lg font-semibold">
          {t('components-loans-detail-payoffcalculatorcard.payoffInformation')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t('components-loans-detail-payoffcalculatorcard.calculatedPayoff')}
        </p>

        {loanType && <Badge variant="outline">{getLoanTypeLabel(t, loanType)}</Badge>}

        <div className="grid grid-cols-2 gap-4">
          <StatCard
            label={t('components-loans-detail-payoffcalculatorcard.remainingTotal')}
            // payoff.* are canonical money strings from the API;
            // parseFloat only at the display boundary.
            value={formatCurrency(Number.parseFloat(payoff.totalIfPaying))}
            tone="neutral"
          />
          <StatCard
            label={t('components-loans-detail-payoffcalculatorcard.payoff')}
            value={formatCurrency(Number.parseFloat(payoff.outstandingBalance))}
            tone="neutral"
          />
        </div>

        {/* Economia highlight */}
        <PayoffMeter
          label={t('components-loans-detail-payoffcalculatorcard.savings')}
          // payoff.* are canonical money strings from the API;
          // parseFloat only at the display boundary.
          amount={formatCurrency(Number.parseFloat(payoff.savings))}
          savingsLabel={t('components-loans-detail-payoffcalculatorcard.savingsPercentLabel')}
          savingsValue={formatPercent(payoff.savingsPercent)}
        />

        <div className="space-y-2 text-sm">
          <p>{t('loanCost.nominal', { rate: formatPercent(Number(payoff.monthlyNominalRate)) })}</p>
          <p>
            {payoff.annualCet
              ? t('loanCost.cetValue', {
                  rate: formatPercent(Number(payoff.annualCet.rate)),
                  source: payoff.annualCet.source ?? '',
                  date: payoff.annualCet.observedOn ?? '',
                })
              : t('loanCost.missingCet')}
          </p>
          <p>{t(`loanCost.quoteStatus.${payoff.payoffQuote.status}`)}</p>
          {payoff.payoffQuote.quotedAmount && (
            <p>
              {t('loanCost.quoteValue', {
                amount: formatCurrency(Number(payoff.payoffQuote.quotedAmount)),
                source: payoff.payoffQuote.source ?? '',
                date: payoff.payoffQuote.quotedOn ?? '',
                until: payoff.payoffQuote.validUntil ?? '',
              })}
            </p>
          )}
          {payoff.payoffQuote.status === 'valid' && payoff.payoffQuote.quotedAmount && (
            <p>
              {t('loanCost.quoteDifference', {
                amount: formatCurrency(
                  Money.fromString(payoff.payoffQuote.quotedAmount, 'BRL')
                    .subtract(Money.fromString(payoff.outstandingBalance, 'BRL'))
                    .toNumber(),
                ),
                savings: formatCurrency(
                  Money.fromString(payoff.totalIfPaying, 'BRL')
                    .subtract(Money.fromString(payoff.payoffQuote.quotedAmount, 'BRL'))
                    .toNumber(),
                ),
              })}
            </p>
          )}
          <p>
            {t('loanCost.release', {
              amount: formatCurrency(Number(payoff.monthlyRelease)),
              payroll: formatCurrency(Number(payoff.payrollRelease)),
              bank: formatCurrency(Number(payoff.bankRelease)),
            })}
          </p>
          <p>
            {t('loanCost.responsibility', {
              value: t(`loanCost.responsibilities.${payoff.economicResponsibility}`),
            })}
          </p>
          <p className="text-muted-foreground">{t('loanCost.releaseHint')}</p>
          {!payoff.cashReady ? (
            <p role="status">{t('loanCost.unreviewedCash')}</p>
          ) : (
            <p>{t('loanCost.cash', { amount: formatCurrency(Number(payoff.availableCash)) })}</p>
          )}
          {payoff.exceedsAvailableCash && <p role="alert">{t('loanCost.insufficientCash')}</p>}
        </div>

        <p className="text-[10px] text-muted-foreground">
          {t('components-loans-detail-payoffcalculatorcard.remainingTotal2')}{' '}
          {formatCurrency(totalRemaining)}
        </p>
      </CardContent>
    </Card>
  );
}
