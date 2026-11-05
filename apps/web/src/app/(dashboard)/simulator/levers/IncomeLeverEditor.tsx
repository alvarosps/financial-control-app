'use client';

import type { Frequency, MonthRef, SimLever } from '@fc/shared';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { frequencyToMonthly } from '@/lib/frequency';
import { toDisplayNumber } from '@/lib/parse';
import { trpc } from '@/lib/trpc/client';
import { LeverEditorFooter } from './LeverEditorFooter';
import {
  INCOME_OPS,
  type IncomeOp,
  type LeverEditorProps,
  leverEditorId,
  nextMonth,
  SELECTABLE_FREQUENCIES,
} from './lever-options';
import { MonthYearPicker } from './MonthYearPicker';
import { useDraftMoney } from './use-draft-money';

/**
 * Editor for an `income_change` lever. The op picker decides which inputs the
 * resolver needs (the resolver is amount-driven — it carries no baseline):
 *
 *  - `add` (a brand-new income/job): a plain amount + frequency + `fromMonth`.
 *  - `adjust` (e.g. a raise) and `end` (an income loss) are BASELINE-RELATIVE:
 *    the user picks one of their REAL income sources (`trpc.income.list`) so the
 *    emitted lever's `amount` is that source's monthly BRL figure. `adjust` also
 *    carries the entered `percent` (resolver delta = amount × percent/100);
 *    `end` carries amount only (resolver places `-amount`, zeroing the income).
 *
 * The `add` amount uses {@link useDraftMoney} (emitting the canonical money
 * string). For `adjust` the percent is parsed with a finite-number guard so a
 * non-numeric entry never emits NaN, and an empty percent is treated as invalid
 * (the resolver requires one). `MonthYearPicker` (Task 22) drives `fromMonth` —
 * it appends its own `-month` suffix, so we pass a clean base id.
 */

/** Round to 2 decimals HALF_UP, matching the domain Money boundary. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function IncomeLeverEditor({ value, onSubmit, onCancel }: LeverEditorProps) {
  const t = useTranslations();
  const labelId = useId();
  const opId = useId();
  const amountId = useId();
  const freqId = useId();
  const percentId = useId();
  const sourceId = useId();
  const existing = value?.kind === 'income_change' ? value : null;

  const [op, setOp] = useState<IncomeOp>(existing?.op ?? 'add');
  const amount = useDraftMoney(existing?.amount ?? '');
  const [percent, setPercent] = useState(
    existing?.percent !== undefined ? String(existing.percent) : '',
  );
  const [frequency, setFrequency] = useState<Frequency>(existing?.frequency ?? 'monthly');
  const [fromMonth, setFromMonth] = useState<MonthRef>(existing?.fromMonth ?? nextMonth());
  const [label, setLabel] = useState(existing?.label ?? '');
  const [sourceAccountId, setSourceAccountId] = useState('');

  // Real income sources back the adjust/end ops. Only fetched/needed when the
  // op is baseline-relative; the query is cheap and shared across the app.
  const baselineRelative = op === 'adjust' || op === 'end';
  const { data: incomeData } = trpc.income.list.useQuery(undefined, { enabled: baselineRelative });
  const sources = (incomeData ?? []).filter((s) => s.config != null && s.schedule != null);
  const selectedSource = sources.find((s) => s.account.id === sourceAccountId);

  /**
   * Monthly BRL figure for the picked source: the per-occurrence native amount
   * converted to its monthly equivalent via the source cadence. The lever is
   * stored as a BRL money string; we keep this simple (no forex re-conversion
   * here) and rely on the source amounts already being BRL for the common case.
   */
  function monthlyAmountFor(source: NonNullable<typeof selectedSource>): string {
    const native = toDisplayNumber(source.schedule?.amount ?? '0');
    const monthly = round2(native * frequencyToMonthly(source.config?.frequency ?? 'monthly'));
    return monthly.toFixed(2);
  }

  // `adjust` requires a finite percent (the zod refinement rejects a missing
  // one). Treat a blank percent as invalid and a non-numeric entry as invalid
  // so the editor never emits NaN.
  const parsedPercent = Number(percent);
  const percentFinite = percent.trim() !== '' && Number.isFinite(parsedPercent);
  const canSubmit = (() => {
    if (op === 'add') return amount.isValid;
    if (op === 'adjust') return selectedSource != null && percentFinite;
    return selectedSource != null;
  })();

  function submit() {
    if (!canSubmit) return;
    const id = leverEditorId(value);

    if (op === 'add') {
      if (amount.normalized === null) return;
      const lever: SimLever = {
        kind: 'income_change',
        id,
        op: 'add',
        amount: amount.normalized,
        frequency,
        fromMonth,
        label: label.trim() || t('simulator.incomeChangeDefaultLabel'),
      };
      onSubmit(lever);
      return;
    }

    if (!selectedSource) return;
    const sourceMonthly = monthlyAmountFor(selectedSource);
    const resolvedLabel = label.trim() || selectedSource.account.name;

    if (op === 'adjust') {
      if (!percentFinite) return;
      const lever: SimLever = {
        kind: 'income_change',
        id,
        op: 'adjust',
        amount: sourceMonthly,
        percent: parsedPercent,
        frequency: 'monthly',
        fromMonth,
        label: resolvedLabel,
      };
      onSubmit(lever);
      return;
    }

    // op === 'end'
    const lever: SimLever = {
      kind: 'income_change',
      id,
      op: 'end',
      amount: sourceMonthly,
      frequency: 'monthly',
      fromMonth,
      label: resolvedLabel,
    };
    onSubmit(lever);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t('simulator.leverKind.income_change')}</p>

      <div className="space-y-1.5">
        <Label htmlFor={labelId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.label')}
        </Label>
        <Input id={labelId} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={opId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.operation')}
        </Label>
        <Select value={op} onValueChange={(v) => setOp((v ?? 'add') as IncomeOp)}>
          <SelectTrigger id={opId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INCOME_OPS.map((o) => (
              <SelectItem key={o} value={o}>
                {t(`simulator.incomeOp.${o}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {op === 'add' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={amountId} className="text-xs text-muted-foreground">
              {t('simulator.leverField.amount')}
            </Label>
            <Input
              id={amountId}
              inputMode="decimal"
              value={amount.value}
              onChange={(e) => amount.setValue(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={freqId} className="text-xs text-muted-foreground">
              {t('simulator.leverField.frequency')}
            </Label>
            <Select
              value={frequency}
              onValueChange={(v) => setFrequency((v ?? 'monthly') as Frequency)}
            >
              <SelectTrigger id={freqId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SELECTABLE_FREQUENCIES.map((f) => (
                  <SelectItem key={f} value={f}>
                    {t(`simulator.freq.${f}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      )}

      {baselineRelative && (
        <div className="space-y-1.5">
          <Label htmlFor={sourceId} className="text-xs text-muted-foreground">
            {t('simulator.leverField.incomeSource')}
          </Label>
          <Select value={sourceAccountId} onValueChange={(v) => setSourceAccountId(v ?? '')}>
            <SelectTrigger id={sourceId} className="w-full">
              <SelectValue placeholder={t('simulator.leverEditor.selectIncomeSourcePlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {sources.map((s) => (
                <SelectItem key={s.account.id} value={s.account.id}>
                  {s.account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {op === 'adjust' && (
        <div className="space-y-1.5">
          <Label htmlFor={percentId} className="text-xs text-muted-foreground">
            {t('simulator.leverField.percent')}
          </Label>
          <Input
            id={percentId}
            inputMode="decimal"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
          />
        </div>
      )}

      <MonthYearPicker
        id={`${opId}-from`}
        label={t('simulator.leverField.fromMonth')}
        value={fromMonth}
        onChange={setFromMonth}
        warnOnCurrentMonth
      />

      <LeverEditorFooter
        existing={value != null}
        canSubmit={canSubmit}
        onCancel={onCancel}
        onSubmit={submit}
      />
    </div>
  );
}
