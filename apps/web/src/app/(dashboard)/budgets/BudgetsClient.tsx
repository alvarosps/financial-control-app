'use client';
import type { AppRouter } from '@fc/api';
import { Money } from '@fc/domain';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { PurchaseSelect } from '@/components/purchases/PurchaseSelect';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { MoneyField } from '@/components/shared/MoneyField';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';

type Budget = inferRouterOutputs<AppRouter>['budget']['list']['items'][number];
type Scope = NonNullable<inferRouterInputs<AppRouter>['budget']['create']['economicScope']>;
function parseLimit(value: string) {
  const normalized = value.includes(',') ? value.replaceAll('.', '').replace(',', '.') : value;
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(normalized)) return null;
  const money = Money.fromString(normalized, 'BRL');
  return money.isPositive() ? money.toDbString() : null;
}
function Amount({ value }: { value: string }) {
  return <AmountDisplay amount={Money.fromString(value, 'BRL').toNumber()} variant="neutral" />;
}

export function BudgetsClient({
  initialMonth,
  initialYear,
}: {
  initialMonth: number;
  initialYear: number;
}) {
  const t = useTranslations('budgets'),
    locale = useLocale(),
    online = useOnlineStatus(),
    utils = trpc.useUtils();
  const [period, setPeriod] = useState(`${initialYear}-${String(initialMonth).padStart(2, '0')}`);
  const [category, setCategory] = useState('all'),
    [scope, setScope] = useState<Scope>('all'),
    [limit, setLimit] = useState('');
  const [editing, setEditing] = useState<Budget | null>(null),
    [editLimit, setEditLimit] = useState(''),
    [failed, setFailed] = useState(false);
  const valid = /^(20\d{2}|21\d{2}|2200)-(0[1-9]|1[0-2])$/.test(period);
  const input = {
    month: Number(period.slice(5, 7)) || 1,
    year: Number(period.slice(0, 4)) || 2000,
  };
  const query = trpc.budget.list.useQuery(input, { enabled: valid, retry: false });
  const categories = trpc.category.list.useQuery();
  const create = trpc.budget.create.useMutation(),
    update = trpc.budget.update.useMutation();
  const busy = create.isPending || update.isPending;
  const data = query.data;
  const names = toArray(categories.data).filter((c) => c.type === 'expense');
  const categoryName = (id: string | null) =>
    id === null
      ? t('allCategories')
      : (names.find((c) => c.id === id)?.name ?? t('unknownCategory'));
  const save = async () => {
    const amount = parseLimit(editing ? editLimit : limit);
    if (!amount) {
      setFailed(true);
      return;
    }
    setFailed(false);
    try {
      if (editing)
        await update.mutateAsync({ id: editing.id, version: editing.version, limitAmount: amount });
      else
        await create.mutateAsync({
          ...input,
          limitAmount: amount,
          categoryId: category === 'all' ? null : category,
          economicScope: scope,
        });
      setEditing(null);
      setLimit('');
      await utils.budget.invalidate();
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="space-y-6">
      <h1 className="font-heading text-2xl font-bold tracking-tight">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('basis')}</p>
      <div className="max-w-xs space-y-2">
        <Label htmlFor="budget-period">{t('period')}</Label>
        <Input
          id="budget-period"
          type="month"
          value={period}
          onChange={(e) => {
            setPeriod(e.target.value);
            setEditing(null);
            setFailed(false);
          }}
          min="2000-01"
          max="2200-12"
        />
      </div>
      {(failed || query.isError) && (
        <p role="alert">
          {t('error')}{' '}
          <Button
            variant="outline"
            onClick={() => {
              void query.refetch();
              setEditing(null);
              setFailed(false);
            }}
          >
            {t('reload')}
          </Button>
        </p>
      )}
      {!online && <p role="status">{t('offline')}</p>}
      {query.isLoading && <p role="status">{t('loading')}</p>}
      {data && (
        <Card surface="glass" className="space-y-3 p-4">
          <h2 className="font-heading text-base font-medium">{t('gross')}</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                'confirmed',
                'committed',
                'provisional',
                'uncategorized',
                'unknownResponsibility',
              ] as const
            ).map((key) => (
              <div key={key}>
                <p className="text-xs text-muted-foreground">{t(key)}</p>
                <Amount value={data.summary[key]} />
              </div>
            ))}
            <div>
              <p className="text-xs text-muted-foreground">{t('receivable')}</p>
              <Amount value={data.receivableOutstanding} />
            </div>
          </div>
          <p className="text-sm">
            {t('coverage', { percent: Math.floor(data.summary.coveragePercent) })} ·{' '}
            {t(data.summary.reliable ? 'reviewed' : 'incomplete')}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('updated', { date: new Date(data.asOf).toLocaleString(locale) })}
          </p>
          <p className="text-sm">
            {t('unallocated', { count: data.provisional.unallocatedCount })}{' '}
            {data.provisional.truncated && t('truncated')}
          </p>
          {data.summary.unsupportedCurrencyCount > 0 && (
            <p>{t('currencyWarning', { count: data.summary.unsupportedCurrencyCount })}</p>
          )}
          <p className="text-sm text-muted-foreground">{t('cashNote')}</p>
          <details>
            <summary className="cursor-pointer text-sm">{t('sources')}</summary>
            <ul className="space-y-2">
              {data.coverage.map((card) => (
                <li key={card.cardAccountId} className="text-sm">
                  {card.cardName}: {t('pending', { count: card.pending })} ·{' '}
                  {card.lastReconciledCycle
                    ? `${card.lastReconciledCycle.month}/${card.lastReconciledCycle.year}`
                    : t('noCycle')}
                </li>
              ))}
            </ul>
          </details>
        </Card>
      )}
      <Card surface="solid" className="p-4">
        <form
          className="grid items-end gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {editing ? (
            <h2 className="sm:col-span-2">
              {t('editing', { category: categoryName(editing.categoryId) })}
            </h2>
          ) : (
            <>
              <PurchaseSelect
                id="budget-category"
                label={t('category')}
                value={category}
                onChange={setCategory}
                options={[
                  { value: 'all', label: t('allCategories') },
                  ...names.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
              <PurchaseSelect
                id="budget-scope"
                label={t('scope')}
                value={scope}
                onChange={(v) => setScope(v as Scope)}
                options={(['all', 'own', 'family', 'work', 'property'] as const).map((value) => ({
                  value,
                  label: t(`scopeValues.${value}`),
                }))}
              />
            </>
          )}
          <MoneyField
            id="budget-limit"
            label={t(editing ? 'newLimit' : 'limit')}
            value={editing ? editLimit : limit}
            onChange={editing ? setEditLimit : setLimit}
            required
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={busy || !online || !valid || !parseLimit(editing ? editLimit : limit)}
            >
              {t(editing ? 'save' : 'create')}
            </Button>
            {editing && (
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                {t('cancel')}
              </Button>
            )}
          </div>
        </form>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.items.map((item) => (
          <Card key={item.id} surface="solid" className="space-y-3 p-4">
            <h2 className="font-heading text-base font-medium">
              {categoryName(item.categoryId)} · {t(`scopeValues.${item.economicScope}`)}
            </h2>
            <dl className="grid grid-cols-2 gap-2">
              <dt>{t('limit')}</dt>
              <dd>
                <Amount value={item.limitAmount} />
              </dd>
              {(['confirmed', 'committed', 'provisional', 'excluded', 'remaining'] as const).map(
                (key) => (
                  <div key={key} className="contents">
                    <dt>{t(key)}</dt>
                    <dd>
                      <Amount value={item.progress[key]} />
                    </dd>
                  </div>
                ),
              )}
            </dl>
            <p>
              {t(
                item.progress.exceeded
                  ? 'exceeded'
                  : item.progress.reliable
                    ? 'reviewed'
                    : 'incomplete',
              )}
            </p>
            <p className="text-sm">
              {t('coverage', { percent: Math.floor(item.progress.coveragePercent) })}
            </p>
            <Button
              variant="outline"
              disabled={busy || !online}
              onClick={() => {
                setEditing(item);
                setEditLimit(item.limitAmount);
                setFailed(false);
              }}
            >
              {t('edit')}
            </Button>
          </Card>
        ))}
      </div>
      {data?.items.length === 0 && <p>{t('empty')}</p>}
    </div>
  );
}
