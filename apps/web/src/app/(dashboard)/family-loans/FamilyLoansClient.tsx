'use client';

import { Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/shared/EmptyState';
import { FilterTabs } from '@/components/shared/FilterTabs';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { StatCard } from '@/components/shared/StatCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePageTitle } from '@/hooks/usePageTitle';
import { formatCurrency, formatCurrencyValue } from '@/lib/format';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { trpc } from '@/lib/trpc/client';

type FamilyLoanFilter = 'all' | 'withIncome' | 'withoutIncome';

export function FamilyLoansClient({ month, year }: { month: number; year: number }) {
  const t = useTranslations();
  usePageTitle(t('familyLoans.title'));

  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.familyLoan.listWithTotals.useQuery({ month, year });

  const [showCreate, setShowCreate] = useState(false);
  const [personName, setPersonName] = useState('');
  const [receiptDay, setReceiptDay] = useState(10);
  const [filter, setFilter] = useState<FamilyLoanFilter>('all');

  const createMutation = trpc.familyLoan.create.useMutation({
    onSuccess: () => {
      utils.familyLoan.listWithTotals.invalidate();
      utils.dashboard.monthlySummary.invalidate();
      setShowCreate(false);
      setPersonName('');
      setReceiptDay(10);
    },
    onError: (error) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  });

  const items = data ?? [];
  const totalMonthlyIncome = items.reduce((sum, d) => sum + (d.monthly?.total ?? 0), 0);

  const withIncome = useMemo(() => items.filter((d) => (d.monthly?.total ?? 0) > 0), [items]);
  const withoutIncome = useMemo(() => items.filter((d) => (d.monthly?.total ?? 0) <= 0), [items]);

  const filtered =
    filter === 'withIncome' ? withIncome : filter === 'withoutIncome' ? withoutIncome : items;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('familyLoans.title')}
        subtitle={t('familyLoans.subtitle')}
        actions={
          <Button variant="brand" size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="size-4" /> {t('familyLoans.actions.add')}
          </Button>
        }
      />

      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {skeletonKeys(6).map((key) => (
            <SkeletonCard key={key} />
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-xl glass border-expense/20 p-4 text-sm text-expense" role="alert">
          {t('common.error')}: {error.message}
        </div>
      )}

      {data && data.length === 0 && (
        <EmptyState
          icon={<Users className="size-12" />}
          title={t('familyLoans.noLoans')}
          description={t('familyLoans.noLoansDescription')}
          action={
            <Button variant="brand" onClick={() => setShowCreate(true)}>
              <Plus className="size-4" /> {t('familyLoans.actions.add')}
            </Button>
          }
        />
      )}

      {data && data.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard
              tone="income"
              label={t('familyLoans.stats.monthlyIncome')}
              value={formatCurrency(totalMonthlyIncome)}
              icon={<Users className="size-4" />}
              delta={{ label: t('familyLoans.stats.monthlyIncomeHint'), direction: 'neutral' }}
            />
            <StatCard
              tone="neutral"
              label={t('familyLoans.stats.people')}
              value={items.length}
              icon={<Users className="size-4" />}
              delta={{
                label: t('familyLoans.stats.peopleHint', { count: items.length }),
                direction: 'neutral',
              }}
            />
            <StatCard
              tone="neutral"
              label={t('familyLoans.stats.activeLoans')}
              value={withIncome.length}
              icon={<Users className="size-4" />}
              delta={{ label: t('familyLoans.stats.activeLoansHint'), direction: 'neutral' }}
            />
          </div>

          {items.length > 0 && (
            <FilterTabs
              tabs={[
                { key: 'all', label: t('familyLoans.filters.all'), count: items.length },
                {
                  key: 'withIncome',
                  label: t('familyLoans.filters.withIncome'),
                  count: withIncome.length,
                },
                {
                  key: 'withoutIncome',
                  label: t('familyLoans.filters.withoutIncome'),
                  count: withoutIncome.length,
                },
              ]}
              value={filter}
              onValueChange={(key) => setFilter(key as FamilyLoanFilter)}
            />
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((item) => (
              <Card
                key={item.account.id}
                surface="solid"
                className="h-full motion-safe:transition-[transform,box-shadow] motion-safe:duration-200 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md"
              >
                <CardContent className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid size-9 shrink-0 place-items-center rounded-full bg-income/10 text-income">
                        <Users className="size-4" />
                      </div>
                      <p className="truncate font-semibold">{item.account.name}</p>
                    </div>
                    <Badge variant="income" role="status">
                      {t('familyLoans.active')}
                    </Badge>
                  </div>

                  {item.monthly && (
                    <div className="rounded-lg bg-income/10 p-3">
                      <p className="text-xs font-medium text-income">
                        {t('familyLoans.card.monthlyTotal')}
                      </p>
                      <p className="text-xl font-bold text-income font-numeric tabular-nums">
                        {formatCurrency(item.monthly.total)}
                      </p>
                    </div>
                  )}

                  {item.monthly && (
                    <dl className="space-y-1.5 text-sm">
                      {item.monthly.borrowedCardTotal > 0 && (
                        <div className="flex items-center justify-between">
                          <dt className="text-muted-foreground">
                            {t('familyLoans.card.cards', {
                              count: item.monthly.borrowedCardBreakdown.length,
                            })}
                          </dt>
                          <dd className="font-medium font-numeric tabular-nums">
                            {formatCurrency(item.monthly.borrowedCardTotal)}
                          </dd>
                        </div>
                      )}
                      {item.monthly.installments > 0 && (
                        <div className="flex items-center justify-between">
                          <dt className="text-muted-foreground">
                            {t('familyLoans.card.installments')}
                          </dt>
                          <dd className="font-medium font-numeric tabular-nums">
                            {formatCurrency(item.monthly.installments)}
                          </dd>
                        </div>
                      )}
                      {item.monthly.discounts > 0 && (
                        <div className="flex items-center justify-between">
                          <dt className="text-expense">{t('familyLoans.card.discounts')}</dt>
                          <dd className="font-medium text-expense font-numeric tabular-nums">
                            -{formatCurrency(item.monthly.discounts)}
                          </dd>
                        </div>
                      )}
                    </dl>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="warning" role="status">
                      {t('familyLoans.card.outstanding', {
                        value: formatCurrencyValue(item.outstanding ?? 0),
                      })}
                    </Badge>
                    {(item.overdue ?? 0) > 0 && (
                      <Badge variant="destructive" role="status">
                        {t('familyLoans.card.overdue', {
                          value: formatCurrencyValue(item.overdue ?? 0),
                        })}
                      </Badge>
                    )}
                  </div>

                  {item.config?.id ? (
                    <Link href={`/family-loans/${item.config.id}`} className="block">
                      <Button variant="outline" className="w-full">
                        {t('familyLoans.viewDetails')}
                      </Button>
                    </Link>
                  ) : (
                    <Button variant="outline" className="w-full" disabled>
                      {t('familyLoans.viewDetails')}
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* Create Dialog */}
      <Dialog
        open={showCreate}
        onOpenChange={(v) => {
          if (!v) {
            setPersonName('');
            setReceiptDay(10);
          }
          setShowCreate(v);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('familyLoans.create.title')}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmedName = personName.trim();
              if (trimmedName)
                createMutation.mutate({
                  personName: trimmedName,
                  receiptDay: Math.min(Math.max(Math.trunc(receiptDay) || 10, 1), 31),
                });
            }}
            className="space-y-3"
          >
            <div>
              <Label htmlFor="person-name" className="text-xs text-muted-foreground">
                {t('familyLoans.create.nameLabel')}
              </Label>
              <Input
                id="person-name"
                value={personName}
                onChange={(e) => setPersonName(e.target.value)}
                placeholder={t('familyLoans.create.namePlaceholder')}
                required
              />
            </div>
            <div>
              <Label htmlFor="person-receipt-day" className="text-xs text-muted-foreground">
                {t('familyLoans.receiptDayLabel')}
              </Label>
              <Input
                id="person-receipt-day"
                type="number"
                min={1}
                max={31}
                value={receiptDay}
                onChange={(e) => setReceiptDay(Number(e.target.value))}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => setShowCreate(false)}>
                {t('familyLoans.create.cancel')}
              </Button>
              <Button variant="brand" type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? t('common.creating') : t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
