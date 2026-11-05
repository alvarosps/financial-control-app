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
 * Editor for an `installment_growth` lever — a recurring installment burden
 * where a NEW installment of `monthlyAmount` begins each month from `fromMonth`
 * and each one lasts `termMonths` (default 12), so the burden grows to
 * `monthlyAmount × termMonths` and then holds steady (rolling window).
 *
 * The amount field uses {@link useDraftMoney} (emitting the canonical money
 * string and gating submit on a valid positive amount) and defaults to the
 * user's historical `averageNewInstallment` (from
 * `trpc.simulator.monthlyAverages`) once that query loads, but only while the
 * field is still untouched (so an edited lever's amount or a value the user
 * typed is never overwritten). The editor surfaces the historical value with a
 * "Usar média" affordance and an accumulation note (the entered amount feeds the
 * note's `{value}` ICU arg).
 *
 * `MonthYearPicker` (Task 22) drives `fromMonth` — it appends its own `-month`
 * suffix, so we pass a clean base id.
 */
export function InstallmentGrowthLeverEditor({ value, onSubmit, onCancel }: LeverEditorProps) {
  const t = useTranslations();
  const labelId = useId();
  const amountId = useId();
  const termId = useId();
  const fromId = useId();
  const existing = value?.kind === 'installment_growth' ? value : null;

  const monthlyAmount = useDraftMoney(existing?.monthlyAmount ?? '');
  const [amountTouched, setAmountTouched] = useState(existing != null);
  const [termMonths, setTermMonths] = useState(
    existing?.termMonths != null ? String(existing.termMonths) : '12',
  );
  const [fromMonth, setFromMonth] = useState<MonthRef>(existing?.fromMonth ?? nextMonth());
  const [label, setLabel] = useState(existing?.label ?? '');

  const termNumber = Number.parseInt(termMonths, 10);
  const termValid = Number.isInteger(termNumber) && termNumber >= 1;

  const { data: averages } = trpc.simulator.monthlyAverages.useQuery();
  const historical = averages?.averageNewInstallment ?? '';

  // Pre-fill the draft amount with the historical new-installment average once
  // it loads, but only while the field is still untouched (never clobber an
  // edited/typed value). The historical value is already a canonical money
  // string, so it flows straight into the draft.
  const { setValue: setMonthlyAmount } = monthlyAmount;
  useEffect(() => {
    if (!amountTouched && historical !== '') setMonthlyAmount(historical);
  }, [amountTouched, historical, setMonthlyAmount]);

  const noteValue = monthlyAmount.value.trim() || historical;

  function submit() {
    if (monthlyAmount.normalized === null || !termValid) return;
    const lever: SimLever = {
      kind: 'installment_growth',
      id: leverEditorId(value),
      monthlyAmount: monthlyAmount.normalized,
      termMonths: termNumber,
      fromMonth,
      label: label.trim() || t('simulator.leverKind.installment_growth'),
    };
    onSubmit(lever);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t('simulator.leverKind.installment_growth')}</p>

      <div className="space-y-1.5">
        <Label htmlFor={labelId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.label')}
        </Label>
        <Input id={labelId} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={amountId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.installmentMonthly')}
        </Label>
        <Input
          id={amountId}
          inputMode="decimal"
          value={monthlyAmount.value}
          onChange={(e) => {
            setAmountTouched(true);
            monthlyAmount.setValue(e.target.value);
          }}
        />
      </div>

      {historical !== '' && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{t('simulator.averages.historicalLabel', { value: historical })}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-auto px-2 py-0.5"
            onClick={() => {
              setAmountTouched(true);
              monthlyAmount.setValue(historical);
            }}
          >
            {t('simulator.averages.useAverage')}
          </Button>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor={termId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.installmentCount')}
        </Label>
        <Input
          id={termId}
          inputMode="numeric"
          value={termMonths}
          onChange={(e) => setTermMonths(e.target.value)}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        {t('simulator.averages.installmentNote', {
          value: noteValue,
          term: termValid ? termNumber : 12,
        })}
      </p>

      <MonthYearPicker
        id={fromId}
        label={t('simulator.leverField.fromMonth')}
        value={fromMonth}
        onChange={setFromMonth}
        warnOnCurrentMonth
      />

      <LeverEditorFooter
        existing={value != null}
        canSubmit={monthlyAmount.isValid && termValid}
        onCancel={onCancel}
        onSubmit={submit}
      />
    </div>
  );
}
