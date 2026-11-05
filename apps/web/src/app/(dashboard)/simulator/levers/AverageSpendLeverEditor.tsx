'use client';

import type { MonthRef, SimLever } from '@fc/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc/client';
import { LeverEditorFooter } from './LeverEditorFooter';
import { type LeverEditorProps, leverEditorId, nextMonth } from './lever-options';
import { MonthYearPicker } from './MonthYearPicker';
import { useDraftMoney } from './use-draft-money';

/**
 * Editor for an `average_spend` lever — a flat additive monthly expense from
 * `fromMonth` to the horizon end, modeling the variable/discretionary spend
 * layer the baseline does not schedule.
 *
 * The amount field uses {@link useDraftMoney} (emitting the canonical money
 * string and gating submit on a valid positive amount) and defaults to the
 * user's historical `averageMonthlySpend` (the typical, outlier-excluded mean
 * from `trpc.simulator.monthlyAverages`) once that query loads, but only while
 * the field is still untouched (so an edited lever's amount or a value the user
 * typed is never overwritten). The editor surfaces the historical average, the
 * per-category breakdown and an additive-note caveat so the user owns the final
 * number.
 *
 * A window selector (3/6/12 months) re-queries the averages for that history
 * span; switching only updates the suggested figure (and refills the amount
 * while still untouched). For transparency, any months dropped as atypical
 * (statistically high spend or IOF-heavy foreign spend) are listed in a muted
 * excluded-months note.
 *
 * `MonthYearPicker` (Task 22) drives `fromMonth` — it appends its own `-month`
 * suffix, so we pass a clean base id.
 */
const WINDOW_OPTIONS = [3, 6, 12] as const;

export function AverageSpendLeverEditor({ value, onSubmit, onCancel }: LeverEditorProps) {
  const t = useTranslations();
  const labelId = useId();
  const amountId = useId();
  const fromId = useId();
  const existing = value?.kind === 'average_spend' ? value : null;

  const amount = useDraftMoney(existing?.amount ?? '');
  const [amountTouched, setAmountTouched] = useState(existing != null);
  const [fromMonth, setFromMonth] = useState<MonthRef>(existing?.fromMonth ?? nextMonth());
  const [label, setLabel] = useState(existing?.label ?? '');
  const [window, setWindow] = useState(12);

  const { data: averages } = trpc.simulator.monthlyAverages.useQuery({ window });
  const historical = averages?.averageMonthlySpend ?? '';

  const excludedNote =
    averages && averages.excludedMonths.length > 0
      ? averages.excludedMonths
          .map((m) => {
            const reasons = m.reasons
              .map((r) =>
                r === 'iof'
                  ? t('simulator.averages.excludedReasonIof')
                  : t('simulator.averages.excludedReasonStatistical'),
              )
              .join(', ');
            return `${t(`simulator.month.${m.month}`)}/${m.year} (${reasons})`;
          })
          .join('; ')
      : '';

  // Pre-fill the draft amount with the historical average once it loads, but
  // only while the field is still untouched (never clobber an edited/typed
  // value). The historical value is already a canonical money string, so it
  // flows straight into the draft.
  const { setValue: setAmount } = amount;
  useEffect(() => {
    if (!amountTouched && historical !== '') setAmount(historical);
  }, [amountTouched, historical, setAmount]);

  const breakdown = averages
    ? [
        { key: 'creditCard', name: t('nav.creditCards'), value: averages.byCategory.creditCard },
        { key: 'loan', name: t('nav.loans'), value: averages.byCategory.loan },
        { key: 'charge', name: t('nav.charges'), value: averages.byCategory.charge },
        {
          key: 'other',
          name: t('simulator.recurring.bucketOption.other'),
          value: averages.byCategory.other,
        },
      ]
    : [];

  function submit() {
    if (amount.normalized === null) return;
    const lever: SimLever = {
      kind: 'average_spend',
      id: leverEditorId(value),
      amount: amount.normalized,
      fromMonth,
      label: label.trim() || t('simulator.leverKind.average_spend'),
    };
    onSubmit(lever);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t('simulator.leverKind.average_spend')}</p>

      <div className="space-y-1.5">
        <Label htmlFor={labelId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.label')}
        </Label>
        <Input id={labelId} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={amountId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.averageAmount')}
        </Label>
        <Input
          id={amountId}
          inputMode="decimal"
          value={amount.value}
          onChange={(e) => {
            setAmountTouched(true);
            amount.setValue(e.target.value);
          }}
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">{t('simulator.averages.windowLabel')}</p>
        <div className="flex gap-1.5">
          {WINDOW_OPTIONS.map((opt) => (
            <Button
              key={opt}
              type="button"
              size="sm"
              variant={opt === window ? 'brand' : 'outline'}
              onClick={() => setWindow(opt)}
            >
              {t('simulator.averages.windowMonths', { count: opt })}
            </Button>
          ))}
        </div>
      </div>

      {historical !== '' && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <span>{t('simulator.averages.historicalLabel', { value: historical })}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-auto px-2 py-0.5"
              onClick={() => {
                setAmountTouched(true);
                amount.setValue(historical);
              }}
            >
              {t('simulator.averages.useAverage')}
            </Button>
          </div>
          {breakdown.length > 0 && (
            <div className="space-y-0.5">
              <p className="font-medium">{t('simulator.averages.byCategoryLabel')}</p>
              <ul className="space-y-0.5">
                {breakdown.map((b) => (
                  <li key={b.key} className="flex justify-between gap-2">
                    <span>{b.name}</span>
                    <span>{b.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {excludedNote !== '' && (
            <p>{t('simulator.averages.excludedLabel', { months: excludedNote })}</p>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t('simulator.averages.additiveNote')}</p>

      <MonthYearPicker
        id={fromId}
        label={t('simulator.leverField.fromMonth')}
        value={fromMonth}
        onChange={setFromMonth}
        warnOnCurrentMonth
      />

      <LeverEditorFooter
        existing={value != null}
        canSubmit={amount.isValid}
        onCancel={onCancel}
        onSubmit={submit}
      />
    </div>
  );
}
