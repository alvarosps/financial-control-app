'use client';

import type { MonthRef, SimLever } from '@fc/shared';
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
import { LeverEditorFooter } from './LeverEditorFooter';
import {
  EVENT_SIGNS,
  type EventSign,
  type LeverEditorProps,
  leverEditorId,
  nextMonth,
} from './lever-options';
import { MonthYearPicker } from './MonthYearPicker';
import { useDraftMoney } from './use-draft-money';

/**
 * Editor for a `one_time_event` lever — a single inflow/outflow on one month.
 * The sign picker toggles inflow vs. outflow (default outflow), the amount uses
 * {@link useDraftMoney} (emitting the canonical money string and gating submit
 * on a valid positive amount), and `MonthYearPicker` (Task 22) drives the
 * target month (it appends its own `-month` suffix, so we pass a clean base id).
 */
export function OneTimeEventLeverEditor({ value, onSubmit, onCancel }: LeverEditorProps) {
  const t = useTranslations();
  const signId = useId();
  const amountId = useId();
  const labelId = useId();
  const monthId = useId();
  const existing = value?.kind === 'one_time_event' ? value : null;

  const [sign, setSign] = useState<EventSign>(existing?.sign ?? 'outflow');
  const amount = useDraftMoney(existing?.amount ?? '');
  const [month, setMonth] = useState<MonthRef>(existing?.month ?? nextMonth());
  const [label, setLabel] = useState(existing?.label ?? '');

  function submit() {
    if (amount.normalized === null) return;
    const lever: SimLever = {
      kind: 'one_time_event',
      id: leverEditorId(value),
      sign,
      amount: amount.normalized,
      month,
      label: label.trim() || t('simulator.oneTimeEventDefaultLabel'),
    };
    onSubmit(lever);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t('simulator.leverKind.one_time_event')}</p>

      <div className="space-y-1.5">
        <Label htmlFor={labelId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.label')}
        </Label>
        <Input id={labelId} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={signId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.direction')}
        </Label>
        <Select value={sign} onValueChange={(v) => setSign((v ?? 'outflow') as EventSign)}>
          <SelectTrigger id={signId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EVENT_SIGNS.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`simulator.eventSign.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

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

      <MonthYearPicker
        id={monthId}
        label={t('simulator.leverField.month')}
        value={month}
        onChange={setMonth}
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
