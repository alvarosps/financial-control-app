'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { ExternalLink, Landmark } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import {
  CollapsibleSpendingSection,
  SPENDING_TONES,
} from '@/components/monthly-spending/CollapsibleSpendingSection';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';
import { getLoanTypeLabel } from '@/lib/labels';
import { cn } from '@/lib/utils';

type LoanData = inferRouterOutputs<AppRouter>['monthlySpending']['get']['loans'][number];

type Props = {
  loans: LoanData[];
};

const tone = SPENDING_TONES.loans;

export function LoansSection({ loans }: Props) {
  const t = useTranslations();

  if (loans.length === 0) return null;

  // Money strings from the API; parseFloat only at the display boundary.
  const total = loans.reduce((sum, loan) => sum + Number.parseFloat(loan.monthlyPayment), 0);

  return (
    <CollapsibleSpendingSection
      tone="loans"
      icon={Landmark}
      title={t('monthlySpending.sections.loans')}
      badge={<Badge variant="warning">{loans.length}</Badge>}
      total={total}
    >
      {loans.map((loan) => (
        <div
          key={loan.accountId}
          className={cn('rounded-md border bg-background/50 px-3 py-2.5', tone.itemBorder)}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-sm font-medium">{loan.name}</span>
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                {loan.installmentNumber}/{loan.totalInstallments}
              </Badge>
              {loan.loanType && (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {getLoanTypeLabel(t, loan.loanType)}
                </Badge>
              )}
              <Link
                href={`/loans/${loan.accountId}`}
                className="ml-1 inline-flex shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={t('monthlySpending.viewDetails')}
              >
                <ExternalLink className="size-3" />
              </Link>
            </div>
            <span
              className={cn('shrink-0 font-numeric text-sm font-semibold tabular-nums', tone.text)}
            >
              {formatCurrency(Number.parseFloat(loan.monthlyPayment))}
            </span>
          </div>

          <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-xs">
            <div>
              <p className="text-muted-foreground">{t('monthlySpending.loan.originalAmount')}</p>
              <p className="font-numeric font-medium tabular-nums">
                {formatCurrency(Number.parseFloat(loan.originalAmount))}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">{t('monthlySpending.loan.monthlyInterest')}</p>
              <p className="font-numeric font-medium tabular-nums">
                {(loan.monthlyInterestRate * 100).toFixed(2)}%
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">{t('monthlySpending.loan.annualInterest')}</p>
              <p className="font-numeric font-medium tabular-nums">
                {(loan.annualInterestRate * 100).toFixed(2)}%
              </p>
            </div>
          </div>
        </div>
      ))}
    </CollapsibleSpendingSection>
  );
}
