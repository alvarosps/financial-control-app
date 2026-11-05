'use client';

import { CalendarClock, ChevronRight, Landmark, Plus, Users } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { AddLoanDialog } from '@/components/loans/AddLoanDialog';
import { LoanCard } from '@/components/loans/LoanCard';
import { EmptyState } from '@/components/shared/EmptyState';
import { FilterTabs } from '@/components/shared/FilterTabs';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { StatCard } from '@/components/shared/StatCard';
import { Button } from '@/components/ui/button';
import { usePageTitle } from '@/hooks/usePageTitle';
import { formatCurrency } from '@/lib/format';
import { getLoanCategoryLabel } from '@/lib/labels';
import { toDisplayNumber } from '@/lib/parse';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { trpc } from '@/lib/trpc/client';
import { cn } from '@/lib/utils';

type LoanFilter = 'all' | 'bank' | 'personal';

export function LoansClient() {
  const locale = useLocale();
  const t = useTranslations();
  usePageTitle(t('pageTitles.loans'));

  const [showAddLoan, setShowAddLoan] = useState(false);
  const [filter, setFilter] = useState<LoanFilter>('all');
  const [paidOffOpen, setPaidOffOpen] = useState(false);

  const { data, isLoading, error } = trpc.loan.list.useQuery();

  const loans = useMemo(
    () => [...(data ?? [])].sort((a, b) => a.account.name.localeCompare(b.account.name, locale)),
    [data, locale],
  );

  const openLoans = loans.filter((loan) => !loan.isPaidOff);
  const paidOffLoans = loans.filter((loan) => loan.isPaidOff);
  const bankLoans = openLoans.filter((loan) => loan.config?.loanCategory === 'bank');
  const personalLoans = openLoans.filter((loan) => loan.config?.loanCategory === 'personal');

  const monthlyFor = (items: typeof loans) =>
    items.reduce((sum, item) => {
      if (item.config == null) return sum;
      const payment = toDisplayNumber(item.config.monthlyPayment);
      const insurance =
        item.config.insuranceAmount != null ? toDisplayNumber(item.config.insuranceAmount) : 0;
      return sum + payment + insurance;
    }, 0);

  const bankMonthly = monthlyFor(bankLoans);
  const personalMonthly = monthlyFor(personalLoans);
  const monthlyTotal = bankMonthly + personalMonthly;

  // Loans actually due this month: those already in progress (current
  // installment > 0). Future loans (not started yet, current installment 0)
  // are excluded — there is nothing to pay for them this month.
  const toPayThisMonth = monthlyFor(openLoans.filter((loan) => loan.currentInstallment > 0));

  const filterLoans = (items: typeof loans) =>
    filter === 'all' ? items : items.filter((loan) => loan.config?.loanCategory === filter);
  const filteredOpen = filterLoans(openLoans);
  const filteredPaidOff = filterLoans(paidOffLoans);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('loans.title')}
        subtitle={t('loans.subtitle')}
        actions={
          <Button variant="brand" size="sm" onClick={() => setShowAddLoan(true)}>
            <Plus className="size-4" /> {t('loans.actions.add')}
          </Button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard
          tone="expense"
          label={t('loans.stats.monthlyTotal')}
          value={formatCurrency(monthlyTotal)}
          icon={<Landmark className="size-4" />}
        />
        <StatCard
          tone="brand"
          label={t('loans.stats.bank')}
          value={bankLoans.length}
          icon={<Landmark className="size-4" />}
          delta={{
            label: t('loans.stats.perMonthDelta', { amount: formatCurrency(bankMonthly) }),
            direction: 'down',
          }}
        />
        <StatCard
          tone="expense"
          label={t('loans.stats.toPayThisMonth')}
          value={formatCurrency(toPayThisMonth)}
          icon={<CalendarClock className="size-4" />}
        />
      </div>

      {loans.length > 0 && (
        <FilterTabs
          tabs={[
            { key: 'all', label: t('loans.filters.all'), count: openLoans.length },
            {
              key: 'bank',
              label: getLoanCategoryLabel(t, 'bank'),
              count: bankLoans.length,
              icon: <Landmark className="size-3.5" />,
            },
            {
              key: 'personal',
              label: getLoanCategoryLabel(t, 'personal'),
              count: personalLoans.length,
              icon: <Users className="size-3.5" />,
            },
          ]}
          value={filter}
          onValueChange={(key) => setFilter(key as LoanFilter)}
        />
      )}

      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {skeletonKeys(6).map((key) => (
            <SkeletonCard key={key} />
          ))}
        </div>
      )}

      {error && (
        <div className="text-expense">
          {t('common.error')}: {error.message}
        </div>
      )}

      {data && loans.length === 0 && (
        <EmptyState
          icon={<Landmark className="size-12" />}
          title={t('loans.noLoans')}
          action={
            <Button variant="brand" onClick={() => setShowAddLoan(true)}>
              <Plus className="size-4" /> {t('loans.actions.add')}
            </Button>
          }
        />
      )}

      {data && loans.length > 0 && filteredOpen.length === 0 && (
        <EmptyState icon={<Landmark className="size-12" />} title={t('loans.noOpenLoans')} />
      )}

      {filteredOpen.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredOpen.map((item) => (
            <LoanCard key={item.account.id} item={item} />
          ))}
        </div>
      )}

      {filteredPaidOff.length > 0 && (
        <section className="overflow-hidden rounded-xl border bg-card">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
            aria-expanded={paidOffOpen}
            onClick={() => setPaidOffOpen((open) => !open)}
          >
            <span className="flex items-center gap-2 font-heading text-base font-medium">
              <ChevronRight
                className={cn(
                  'size-4 text-muted-foreground transition-transform motion-reduce:transition-none',
                  paidOffOpen && 'rotate-90',
                )}
              />
              {t('loans.paidOffSection')} ({filteredPaidOff.length})
            </span>
          </button>
          {paidOffOpen && (
            <div className="grid grid-cols-1 gap-4 border-t p-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredPaidOff.map((item) => (
                <LoanCard key={item.account.id} item={item} />
              ))}
            </div>
          )}
        </section>
      )}

      <AddLoanDialog open={showAddLoan} onOpenChange={setShowAddLoan} />
    </div>
  );
}
