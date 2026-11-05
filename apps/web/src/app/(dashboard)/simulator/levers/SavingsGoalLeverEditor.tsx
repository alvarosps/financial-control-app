'use client';

import type { MonthRef, SimLever } from '@fc/shared';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LeverEditorFooter } from './LeverEditorFooter';
import { type LeverEditorProps, leverEditorId } from './lever-options';
import { MonthYearPicker } from './MonthYearPicker';
import { useDraftMoney } from './use-draft-money';

/**
 * Editor for a `savings_goal` lever — a target cash balance to reach by a given
 * month. The target uses {@link useDraftMoney} (emitting the canonical money
 * string and gating submit on a valid positive amount) and `MonthYearPicker`
 * (Task 22) drives the by-month value (it appends its own `-month` suffix, so we
 * pass a clean base id).
 */
function defaultByMonth(): MonthRef {
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() + 1 };
}

export function SavingsGoalLeverEditor({ value, onSubmit, onCancel }: LeverEditorProps) {
  const t = useTranslations();
  const targetId = useId();
  const labelId = useId();
  const monthId = useId();
  const existing = value?.kind === 'savings_goal' ? value : null;

  const target = useDraftMoney(existing?.target ?? '');
  const [byMonth, setByMonth] = useState<MonthRef>(existing?.byMonth ?? defaultByMonth());
  const [label, setLabel] = useState(existing?.label ?? '');

  function submit() {
    if (target.normalized === null) return;
    const lever: SimLever = {
      kind: 'savings_goal',
      id: leverEditorId(value),
      target: target.normalized,
      byMonth,
      label: label.trim() || t('simulator.savingsGoal.defaultLabel'),
    };
    onSubmit(lever);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t('simulator.leverKind.savings_goal')}</p>

      <div className="space-y-1.5">
        <Label htmlFor={labelId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.label')}
        </Label>
        <Input id={labelId} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={targetId} className="text-xs text-muted-foreground">
          {t('simulator.savingsGoal.target')}
        </Label>
        <Input
          id={targetId}
          inputMode="decimal"
          value={target.value}
          onChange={(e) => target.setValue(e.target.value)}
        />
      </div>

      <MonthYearPicker
        id={monthId}
        label={t('simulator.savingsGoal.byMonth')}
        value={byMonth}
        onChange={setByMonth}
      />

      <LeverEditorFooter
        existing={value != null}
        canSubmit={target.isValid}
        onCancel={onCancel}
        onSubmit={submit}
      />
    </div>
  );
}
