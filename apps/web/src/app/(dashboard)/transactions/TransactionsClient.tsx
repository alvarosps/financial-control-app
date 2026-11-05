'use client';

import type { AppRouter } from '@fc/api';
import { keepPreviousData } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { ArrowLeftRight } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import type * as React from 'react';
import { useMemo, useState } from 'react';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { CashMovementsView } from '@/components/shared/CashMovementsView';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { FilterTabs } from '@/components/shared/FilterTabs';
import { FinancialObligationsView } from '@/components/shared/FinancialObligationsView';
import { MonthNavigator } from '@/components/shared/MonthNavigator';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { type ColumnDef, DataTable } from '@/components/ui/data-table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMonthNavigation } from '@/hooks/useMonthNavigation';
import { usePageTitle } from '@/hooks/usePageTitle';
import { toDisplayNumber } from '@/lib/parse';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { transactionDisplayDate } from '@/lib/transaction-date';
import { trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';

type Tx = inferRouterOutputs<AppRouter>['transaction']['list'][number];
type AccountListOutput = inferRouterOutputs<AppRouter>['account']['list'];
type Account = Extract<AccountListOutput, unknown[]>[number];

type TypeFilter = 'all' | 'withdrawal' | 'deposit' | 'transfer';

const TYPE_VARIANT: Record<string, 'expense' | 'income' | 'neutral'> = {
  withdrawal: 'expense',
  deposit: 'income',
  transfer: 'neutral',
};

function formatDate(date: Date | string, locale: string): string {
  return new Date(date).toLocaleDateString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function accountLink(account: Account | undefined, tx: Tx): React.ReactNode {
  if (!account) return '—';
  if (account.type === 'credit_card') {
    const month = tx.billingMonth ?? new Date(tx.date).getMonth() + 1;
    const year = tx.billingYear ?? new Date(tx.date).getFullYear();
    return (
      <Link
        href={`/credit-cards/${account.id}?month=${month}&year=${year}`}
        className="hover:text-primary hover:underline underline-offset-2 transition-colors font-medium text-foreground"
      >
        {account.name}
      </Link>
    );
  }
  if (account.type === 'loan') {
    return (
      <Link
        href={`/loans/${account.id}`}
        className="hover:text-primary hover:underline underline-offset-2 transition-colors font-medium text-foreground"
      >
        {account.name}
      </Link>
    );
  }
  return account.name;
}

function TransactionDetailsClient({
  month,
  year,
  accountId,
  setAccountId,
  goToPreviousMonth,
  goToNextMonth,
}: {
  month: number;
  year: number;
  accountId: string | undefined;
  setAccountId: (value: string | undefined) => void;
  goToPreviousMonth: () => void;
  goToNextMonth: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations();
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [page, setPage] = useState(1);

  const { data: rawAccounts } = trpc.account.list.useQuery();
  const accounts = toArray(rawAccounts);

  // Base UI's Select.Value renders the raw value until the (portalled) items mount;
  // providing `items` lets it resolve the label on first render.
  const accountItems = useMemo(
    () => [
      { value: 'all', label: t('transactions.allAccounts') },
      ...accounts.map((account) => ({ value: account.id, label: account.name })),
    ],
    [accounts, t],
  );

  const { data: rawCategories } = trpc.category.list.useQuery();
  const categories = toArray(rawCategories);

  const {
    data: rawTransactions,
    isPending,
    error,
    refetch,
  } = trpc.transaction.details.useQuery(
    {
      month,
      year,
      accountId,
      page,
      pageSize: 40,
      type: typeFilter === 'all' ? undefined : typeFilter,
    },
    { placeholderData: keepPreviousData },
  );
  const transactions = rawTransactions?.items ?? [];
  const showSkeleton = isPending && rawTransactions === undefined;

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const columns: ColumnDef<Tx>[] = useMemo(
    () => [
      {
        accessorKey: 'date',
        header: t('transactions.date'),
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {transactionDisplayDate(row.original) === null
              ? t('statement.unknownDate')
              : formatDate(transactionDisplayDate(row.original) ?? row.original.date, locale)}
            {row.original.domainType === 'credit_card_installment' && (
              <span className="block text-xs">{t('statement.occurrenceDate')}</span>
            )}
          </span>
        ),
        sortingFn: (a, b) =>
          new Date(transactionDisplayDate(a.original) ?? 0).getTime() -
          new Date(transactionDisplayDate(b.original) ?? 0).getTime(),
      },
      {
        accessorKey: 'description',
        header: t('transactions.description'),
        cell: ({ row }) => {
          const tx = row.original;
          return (
            <span>
              <span className="font-medium">{tx.description}</span>
              {tx.installmentNumber != null && tx.totalInstallments != null && (
                <Badge variant="secondary" className="ml-2 align-middle">
                  {tx.installmentNumber}/{tx.totalInstallments}
                </Badge>
              )}
            </span>
          );
        },
      },
      {
        id: 'source',
        header: t('transactions.source'),
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {accountLink(accountById.get(row.original.sourceAccountId), row.original)}
          </span>
        ),
      },
      {
        id: 'destination',
        header: t('transactions.destination'),
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {accountLink(accountById.get(row.original.destinationAccountId), row.original)}
          </span>
        ),
      },
      {
        id: 'category',
        header: t('transactions.category'),
        enableSorting: false,
        cell: ({ row }) => {
          const category = row.original.categoryId
            ? categoryById.get(row.original.categoryId)
            : undefined;
          return category ? (
            <Badge variant="outline">
              {category.icon ? `${category.icon} ` : ''}
              {category.name}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      },
      {
        id: 'status',
        header: t('transactions.status'),
        enableSorting: false,
        cell: ({ row }) => <StatusBadge status={row.original.isPaid ? 'paid' : 'pending'} />,
      },
      {
        accessorKey: 'amount',
        header: () => <span className="block text-right">{t('transactions.amount')}</span>,
        cell: ({ row }) => {
          const tx = row.original;
          const variant = TYPE_VARIANT[tx.type] ?? 'neutral';
          return (
            <div className="text-right">
              <AmountDisplay
                amount={toDisplayNumber(tx.amount) * (tx.type === 'withdrawal' ? -1 : 1)}
                variant={variant}
                showSign={tx.type !== 'transfer'}
                size="sm"
              />
            </div>
          );
        },
        sortingFn: (a, b) =>
          toDisplayNumber(a.original.amount) - toDisplayNumber(b.original.amount),
      },
    ],
    [t, accountById, categoryById, locale],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('transactions.title')}
        subtitle={t('transactions.subtitle')}
        actions={
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            <Select
              value={accountId ?? 'all'}
              onValueChange={(val) => setAccountId(val == null || val === 'all' ? undefined : val)}
              items={accountItems}
            >
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder={t('transactions.allAccounts')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('transactions.allAccounts')}</SelectItem>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <MonthNavigator
                month={month}
                year={year}
                onPrev={goToPreviousMonth}
                onNext={goToNextMonth}
              />
            </div>
          </div>
        }
      />

      <p className="text-sm text-muted-foreground">{t('financial.detailHelp')}</p>

      {!showSkeleton && !error && (
        <FilterTabs
          tabs={[
            { key: 'all', label: t('transactions.filters.all') },
            {
              key: 'withdrawal',
              label: t('transactions.filters.withdrawal'),
            },
            { key: 'deposit', label: t('transactions.filters.deposit') },
            {
              key: 'transfer',
              label: t('transactions.filters.transfer'),
            },
          ]}
          value={typeFilter}
          onValueChange={(key) => {
            setTypeFilter(key as TypeFilter);
            setPage(1);
          }}
        />
      )}

      {showSkeleton && (
        <div className="space-y-3">
          {skeletonKeys(6).map((key) => (
            <SkeletonCard key={key} />
          ))}
        </div>
      )}

      {error && <ErrorAlert message={error.message} onRetry={() => void refetch()} />}

      {!showSkeleton && !error && transactions.length === 0 && (
        <EmptyState
          icon={<ArrowLeftRight className="h-12 w-12" />}
          title={t('transactions.noTransactions')}
          description={t('transactions.noTransactionsDescription')}
        />
      )}

      {!showSkeleton && !error && transactions.length > 0 && (
        <DataTable
          columns={columns}
          data={transactions}
          emptyMessage={t('transactions.noTransactions')}
        />
      )}
      <div className="flex gap-2">
        <Button variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          {t('financial.previous')}
        </Button>
        <Button
          variant="outline"
          disabled={!rawTransactions || page >= rawTransactions.totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          {t('financial.next')}
        </Button>
      </div>
    </div>
  );
}

function updateParam(key: string, value?: string) {
  const params = new URLSearchParams(window.location.search);
  if (value) params.set(key, value);
  else params.delete(key);
  window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
}

export function TransactionsClient({
  initialMonth,
  initialYear,
}: {
  initialMonth: number;
  initialYear: number;
}) {
  const t = useTranslations();
  usePageTitle(t('pageTitles.transactions'));
  const params = useSearchParams();
  const view = params?.get('view') ?? 'summary';
  const setView = (value: string) => updateParam('view', value);
  const requestedMonth = Number(params?.get('month'));
  const requestedYear = Number(params?.get('year'));
  const { month, year, goToPreviousMonth, goToNextMonth } = useMonthNavigation(
    requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth : initialMonth,
    requestedYear >= 2000 && requestedYear <= 2100 ? requestedYear : initialYear,
  );
  const accountId = params?.get('accountId') ?? undefined;
  const setAccountId = (value: string | undefined) => updateParam('accountId', value);
  const accounts = trpc.account.list.useQuery();
  const items = [
    { value: 'all', label: t('transactions.allAccounts') },
    ...toArray(accounts.data).map((a) => ({ value: a.id, label: a.name })),
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {(['summary', 'cash', 'details'] as const).map((key) => (
          <Button
            key={key}
            variant={view === key ? 'default' : 'outline'}
            onClick={() => setView(key)}
          >
            {t(`financial.${key}`)}
          </Button>
        ))}
      </div>
      {view === 'details' ? (
        <TransactionDetailsClient
          key={`${month}-${year}-${accountId}`}
          month={month}
          year={year}
          accountId={accountId}
          setAccountId={setAccountId}
          goToPreviousMonth={goToPreviousMonth}
          goToNextMonth={goToNextMonth}
        />
      ) : (
        <>
          <PageHeader
            title={t('pageTitles.transactions')}
            actions={
              <MonthNavigator
                month={month}
                year={year}
                onPrev={goToPreviousMonth}
                onNext={goToNextMonth}
              />
            }
          />
          <Select
            items={items}
            value={accountId ?? 'all'}
            onValueChange={(value) =>
              setAccountId(value === 'all' ? undefined : (value ?? undefined))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {view === 'cash' ? (
            <CashMovementsView
              key={`${month}-${year}-${accountId}`}
              month={month}
              year={year}
              accountId={accountId}
            />
          ) : (
            <FinancialObligationsView
              key={`${month}-${year}-${accountId}`}
              month={month}
              year={year}
              accountId={accountId}
              initialFilter={params?.get('filter') ?? 'all'}
              onFilterChange={(value) => updateParam('filter', value)}
            />
          )}
        </>
      )}
    </div>
  );
}
