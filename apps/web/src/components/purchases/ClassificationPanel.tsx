'use client';
import type { AppRouter } from '@fc/api';
import { Money } from '@fc/domain';
import type { inferRouterInputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';
import { PurchaseSelect } from './PurchaseSelect';

type Apply = inferRouterInputs<AppRouter>['category']['applyClassification'];
export function ClassificationPanel({ initialMonth }: { initialMonth: string }) {
  const t = useTranslations('classification');
  const locale = useLocale();
  const online = useOnlineStatus();
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState(initialMonth);
  const [selected, setSelected] = useState<Apply['items']>([]);
  const [category, setCategory] = useState('keep');
  const [responsibility, setResponsibility] = useState('keep');
  const [receivable, setReceivable] = useState('keep');
  const [ruleId, setRuleId] = useState('none');
  const [merchant, setMerchant] = useState('');
  const [card, setCard] = useState('all');
  const [priority, setPriority] = useState('0');
  const [reason, setReason] = useState('');
  const [prepared, setPrepared] = useState<Apply | null>(null);
  const [error, setError] = useState(false);
  const validPeriod =
    /^\d{4}-(0[1-9]|1[0-2])$/.test(period) &&
    Number(period.slice(0, 4)) >= 2000 &&
    Number(period.slice(0, 4)) <= 2200;
  const query = trpc.category.classificationPreview.useInfiniteQuery(
    { month: Number(period.slice(5, 7)) || 1, year: Number(period.slice(0, 4)) || 2000 },
    {
      enabled: validPeriod,
      retry: false,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  const categories = trpc.category.list.useQuery();
  const accounts = trpc.account.list.useQuery();
  const rules = trpc.category.classificationRules.useQuery();
  const history = trpc.category.classificationHistory.useQuery();
  const apply = trpc.category.applyClassification.useMutation();
  const undo = trpc.category.undoClassification.useMutation();
  const createRule = trpc.category.createClassificationRule.useMutation();
  const toggleRule = trpc.category.setClassificationRuleEnabled.useMutation();
  const busy = apply.isPending || undo.isPending || createRule.isPending || toggleRule.isPending;
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const coverage = query.data?.pages[0]?.coverage;
  const availableCategories = toArray(categories.data).filter((c) => c.type === 'expense');
  const categoryName = (id: string | null) =>
    availableCategories.find((c) => c.id === id)?.name ?? t('uncategorized');
  const rule = rules.data?.find((r) => r.id === ruleId && r.enabled);
  const selectedRows = rows.filter((r) => selected.some((s) => s.id === r.id));
  const refresh = async () => {
    await Promise.all([
      utils.category.invalidate(),
      utils.dashboard.invalidate(),
      utils.transaction.invalidate(),
      utils.budget.invalidate(),
    ]);
  };
  const act = async (work: () => Promise<unknown>) => {
    setError(false);
    try {
      await work();
      await refresh();
    } catch {
      setError(true);
    }
  };
  const change = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setPrepared(null);
  };
  const hasChange =
    Boolean(rule) || category !== 'keep' || responsibility !== 'keep' || receivable !== 'keep';
  const preview = () =>
    setPrepared({
      items: selected,
      ...(rule
        ? { ruleId: rule.id, ruleVersion: rule.version }
        : category !== 'keep'
          ? { categoryId: category === 'none' ? null : category }
          : {}),
      ...(responsibility !== 'keep'
        ? { economicResponsibility: responsibility as Apply['economicResponsibility'] }
        : {}),
      ...(receivable !== 'keep'
        ? { receivableAccountId: receivable === 'none' ? null : receivable }
        : {}),
    });
  const percentage =
    coverage && Money.fromString(coverage.totalAmount, 'BRL').isPositive()
      ? Money.fromString(coverage.reviewedAmount, 'BRL')
          .toDecimal()
          .div(coverage.totalAmount)
          .times(100)
          .toFixed(1)
      : '0.0';
  return (
    <Card surface="solid" className="space-y-4 p-4">
      <h2 className="font-heading text-base font-medium leading-snug">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('explanation')}</p>
      <div className="max-w-xs space-y-2">
        <Label htmlFor="classification-month">{t('month')}</Label>
        <Input
          id="classification-month"
          type="month"
          min="2000-01"
          max="2200-12"
          value={period}
          onChange={(e) => {
            setPeriod(e.target.value);
            setSelected([]);
            setPrepared(null);
          }}
        />
      </div>
      {coverage && (
        <div className="space-y-1 text-sm" aria-live="polite">
          <p>
            {t('coverage', { reviewed: coverage.reviewedCount, total: coverage.count, percentage })}
          </p>
          <p>{t('responsibilityMissing', { count: coverage.unknownResponsibilityCount })}</p>
          <p>
            {t('valueCoverage', {
              reviewed: Money.fromString(coverage.reviewedAmount, 'BRL').format(locale),
              total: Money.fromString(coverage.totalAmount, 'BRL').format(locale),
            })}
          </p>
          {coverage.unsupportedCurrencyCount > 0 && (
            <p>{t('currencyMissing', { count: coverage.unsupportedCurrencyCount })}</p>
          )}
        </div>
      )}
      {(error ||
        query.error ||
        categories.error ||
        accounts.error ||
        rules.error ||
        history.error) && <p role="alert">{t('error')}</p>}
      {!online && <p role="status">{t('offline')}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <PurchaseSelect
          id="classification-category"
          label={t('category')}
          value={category}
          onChange={change(setCategory)}
          options={[
            { value: 'keep', label: t('keep') },
            { value: 'none', label: t('uncategorized') },
            ...availableCategories.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <PurchaseSelect
          id="classification-responsibility"
          label={t('responsibility')}
          value={responsibility}
          onChange={change(setResponsibility)}
          options={[
            { value: 'keep', label: t('keep') },
            ...(['unknown', 'own', 'family', 'work', 'property'] as const).map((v) => ({
              value: v,
              label: t(`responsibilities.${v}`),
            })),
          ]}
        />
        <PurchaseSelect
          id="classification-receivable"
          label={t('receivable')}
          value={receivable}
          onChange={change(setReceivable)}
          options={[
            { value: 'keep', label: t('keep') },
            { value: 'none', label: t('noReceivable') },
            ...toArray(accounts.data)
              .filter((a) => a.type === 'family_loan')
              .map((a) => ({ value: a.id, label: a.name })),
          ]}
        />
        <PurchaseSelect
          id="classification-rule"
          label={t('rule')}
          value={ruleId}
          onChange={change(setRuleId)}
          options={[
            { value: 'none', label: t('noRule') },
            ...(rules.data ?? [])
              .filter((r) => r.enabled)
              .map((r) => ({
                value: r.id,
                label: `${r.merchant} → ${categoryName(r.categoryId)}`,
              })),
          ]}
        />
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id} className="rounded-lg border p-3 text-sm">
            <label className="flex min-h-11 items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 size-5 shrink-0"
                disabled={
                  busy || (!selected.some((s) => s.id === row.id) && selected.length >= 100)
                }
                checked={selected.some((s) => s.id === row.id)}
                onChange={(e) => {
                  setPrepared(null);
                  setSelected(
                    e.target.checked
                      ? [...selected, { id: row.id, version: row.version }]
                      : selected.filter((s) => s.id !== row.id),
                  );
                }}
              />
              <span className="min-w-0 flex-1 break-words">
                {row.description}
                <span className="block text-muted-foreground">
                  {categoryName(row.categoryId)} ·{' '}
                  {t(`responsibilities.${row.economicResponsibility}`)}
                </span>
                {row.suggestion && (
                  <span className="block">
                    {t('suggestion', { category: categoryName(row.suggestion.categoryId) })} ·{' '}
                    {t(row.suggestion.confidence === 'ambiguous' ? 'ambiguous' : 'exact')}
                  </span>
                )}
              </span>
              <AmountDisplay amount={Number(row.amount)} currency={row.currency} />
            </label>
          </li>
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t('more')}
        </Button>
      )}
      <Button disabled={!online || busy || !selected.length || !hasChange} onClick={preview}>
        {t('preview')}
      </Button>
      {prepared && (
        <section className="space-y-3 rounded-lg border p-3" aria-label={t('preview')}>
          <p className="text-sm">{t('confirmHint')}</p>
          <ul className="space-y-2 text-sm">
            {selectedRows.map((r) => (
              <li key={r.id} className="break-words">
                {r.description}: {categoryName(r.categoryId)} →{' '}
                {categoryName(
                  rule?.categoryId ??
                    (category === 'keep' ? r.categoryId : category === 'none' ? null : category),
                )}{' '}
                ·{' '}
                {t(
                  `responsibilities.${prepared.economicResponsibility ?? r.economicResponsibility}`,
                )}
              </li>
            ))}
          </ul>
          <p className="text-sm">{t('noCashChange')}</p>
          <Button
            disabled={!online || busy}
            onClick={() =>
              void act(async () => {
                await apply.mutateAsync(prepared);
                setPrepared(null);
                setSelected([]);
              })
            }
          >
            {t('confirm')}
          </Button>
        </section>
      )}
      <details className="space-y-3">
        <summary className="cursor-pointer py-3 font-heading text-base font-medium">
          {t('rules')}
        </summary>
        <p className="text-sm">{t('ruleHint')}</p>
        <Label htmlFor="classification-merchant">{t('merchant')}</Label>
        <Input
          id="classification-merchant"
          value={merchant}
          maxLength={500}
          onChange={(e) => setMerchant(e.target.value)}
        />
        <PurchaseSelect
          id="classification-rule-card"
          label={t('cardScope')}
          value={card}
          onChange={setCard}
          options={[
            { value: 'all', label: t('allCards') },
            ...toArray(accounts.data)
              .filter((a) => a.type === 'credit_card')
              .map((a) => ({ value: a.id, label: a.name })),
          ]}
        />
        <Label htmlFor="classification-priority">{t('priority')}</Label>
        <Input
          id="classification-priority"
          type="number"
          min={0}
          max={1000}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
        <Button
          disabled={
            !online ||
            busy ||
            !merchant.trim() ||
            !availableCategories.some((c) => c.id === category) ||
            !Number.isInteger(Number(priority)) ||
            Number(priority) < 0 ||
            Number(priority) > 1000
          }
          onClick={() =>
            void act(async () => {
              await createRule.mutateAsync({
                merchant,
                categoryId: category,
                cardAccountId: card === 'all' ? null : card,
                priority: Number(priority),
              });
              setMerchant('');
            })
          }
        >
          {t('createRule')}
        </Button>
        <ul>
          {(rules.data ?? []).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="break-words">
                {r.merchant} → {categoryName(r.categoryId)} ·{' '}
                {r.cardAccountId
                  ? toArray(accounts.data).find((a) => a.id === r.cardAccountId)?.name
                  : t('allCards')}{' '}
                · {t('priority')}: {r.priority}
              </span>
              <Button
                variant="outline"
                disabled={!online || busy}
                onClick={() =>
                  void act(() =>
                    toggleRule.mutateAsync({ id: r.id, version: r.version, enabled: !r.enabled }),
                  )
                }
              >
                {t(r.enabled ? 'disableRule' : 'enableRule')}
              </Button>
            </li>
          ))}
        </ul>
      </details>
      <details className="space-y-3">
        <summary className="cursor-pointer py-3 font-heading text-base font-medium">
          {t('history')}
        </summary>
        <Label htmlFor="classification-undo-reason">{t('undoReason')}</Label>
        <Input
          id="classification-undo-reason"
          value={reason}
          maxLength={1000}
          onChange={(e) => setReason(e.target.value)}
        />
        <ul>
          {(history.data ?? []).map((batch) => (
            <li key={batch.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span>
                {new Date(batch.createdAt).toLocaleString(locale)} ·{' '}
                {t('batchCount', { count: batch.count })}
              </span>
              {batch.undoneAt ? (
                <span>{t('undone')}</span>
              ) : (
                <Button
                  variant="outline"
                  disabled={!online || busy || reason.trim().length < 3}
                  onClick={() =>
                    void act(async () => {
                      await undo.mutateAsync({ batchId: batch.id, reason });
                      setReason('');
                      setSelected([]);
                      setPrepared(null);
                    })
                  }
                >
                  {t('undo')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
