'use client';

import type { MonthRef, SimLever } from '@fc/shared';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc/client';
import { LeverEditorFooter } from './LeverEditorFooter';
import { type LeverEditorProps, leverEditorId, nextMonth } from './lever-options';
import { MonthYearPicker } from './MonthYearPicker';
import { useDraftMoney } from './use-draft-money';

/**
 * Editor for an `installment_plan` lever — a FINITE installment plan where a
 * fixed `amount` is charged each month for `installments` months starting at
 * `startMonth` (so the burden ends after the term, unlike the accumulating
 * `installment_growth`).
 *
 * The amount uses {@link useDraftMoney} (emitting the canonical money string and
 * gating submit on a valid positive amount); the installment count is a plain
 * draft validated as an integer >= 1. There is no auto-prefill: instead the
 * editor offers history-based suggestions (recent recurring purchases from
 * `trpc.simulator.installmentSuggestions`) as clickable chips that fill both
 * fields, while manual entry is always allowed.
 *
 * `MonthYearPicker` drives `startMonth` — it appends its own `-month` suffix, so
 * we pass a clean base id.
 */
export function InstallmentPlanLeverEditor({ value, onSubmit, onCancel }: LeverEditorProps) {
  const t = useTranslations();
  const labelId = useId();
  const amountId = useId();
  const installmentsId = useId();
  const startId = useId();
  const existing = value?.kind === 'installment_plan' ? value : null;

  const amount = useDraftMoney(existing?.amount ?? '');
  const [installments, setInstallments] = useState(
    existing != null ? String(existing.installments) : '',
  );
  const [startMonth, setStartMonth] = useState<MonthRef>(existing?.startMonth ?? nextMonth());
  const [label, setLabel] = useState(existing?.label ?? '');

  const { data: suggestions } = trpc.simulator.installmentSuggestions.useQuery();

  const parsedInstallments = Number(installments);
  const installmentsOk = Number.isInteger(parsedInstallments) && parsedInstallments >= 1;
  const canSubmit = amount.isValid && installmentsOk;

  function submit() {
    if (amount.normalized === null || !installmentsOk) return;
    const lever: SimLever = {
      kind: 'installment_plan',
      id: leverEditorId(value),
      amount: amount.normalized,
      installments: parsedInstallments,
      startMonth,
      label: label.trim() || t('simulator.leverKind.installment_plan'),
    };
    onSubmit(lever);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t('simulator.leverKind.installment_plan')}</p>

      {suggestions?.length ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            {t('simulator.averages.suggestionsLabel')}
          </p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s, i) => (
              <Button
                // biome-ignore lint/suspicious/noArrayIndexKey: static read-only list (no reorder/add/remove); the index disambiguates byte-identical history rows
                key={`${s.label}-${s.amount}-${s.installments}-${i}`}
                type="button"
                size="sm"
                variant="outline"
                className="h-auto px-2 py-0.5 text-xs"
                onClick={() => {
                  amount.setValue(s.amount);
                  setInstallments(String(s.installments));
                }}
              >
                {s.label} · {s.amount} × {s.installments}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor={labelId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.label')}
        </Label>
        <Input id={labelId} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={amountId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.installmentAmount')}
        </Label>
        <Input
          id={amountId}
          inputMode="decimal"
          value={amount.value}
          onChange={(e) => amount.setValue(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={installmentsId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.installmentCount')}
        </Label>
        <Input
          id={installmentsId}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={installments}
          onChange={(e) => setInstallments(e.target.value)}
        />
      </div>

      <MonthYearPicker
        id={startId}
        label={t('simulator.leverField.fromMonth')}
        value={startMonth}
        onChange={setStartMonth}
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
