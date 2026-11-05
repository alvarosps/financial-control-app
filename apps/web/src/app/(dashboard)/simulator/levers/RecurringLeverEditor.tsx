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
import { formatCurrency } from '@/lib/format';
import { toDisplayNumber } from '@/lib/parse';
import { trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';
import { LeverEditorFooter } from './LeverEditorFooter';
import {
  type LeverEditorProps,
  leverEditorId,
  nextMonth,
  RECURRING_OPS,
  type RecurringOp,
  SELECTABLE_FREQUENCIES,
} from './lever-options';
import { MonthYearPicker } from './MonthYearPicker';
import { useDraftMoney } from './use-draft-money';

/**
 * Editor for a `recurring_change` lever. The op picker decides the shape:
 *
 *  - `cancel`: a MULTI-select of the user's active scheduled transactions
 *    (`trpc.scheduled.list`, filtered to `isActive`). Each checked schedule
 *    becomes its own `recurring_change` lever (one per `scheduledTransactionId`),
 *    so `onSubmit` is called once per selection — `LeverPanel` accumulates them.
 *    Adds mint a fresh uuid each, but EDITING an existing single-select cancel
 *    lever reuses its id so the panel REPLACES it rather than appending an
 *    orphan.
 *  - `add`: a brand-new recurring item — amount + frequency + start month +
 *    label — emits a single `recurring_change` lever.
 *
 * The `add` amount uses {@link useDraftMoney} (emitting the canonical money
 * string and gating submit on a valid positive amount). `MonthYearPicker`
 * (Task 22) drives the start month — it appends its own `-month` suffix, so we
 * pass a clean id.
 */
export function RecurringLeverEditor({ value, onSubmit, onCancel }: LeverEditorProps) {
  const t = useTranslations();
  const opId = useId();
  const labelId = useId();
  const amountId = useId();
  const freqId = useId();
  const existing = value?.kind === 'recurring_change' ? value : null;

  const [op, setOp] = useState<RecurringOp>(existing?.op ?? 'cancel');
  const [selectedIds, setSelectedIds] = useState<string[]>(
    existing?.scheduledTransactionId ? [existing.scheduledTransactionId] : [],
  );
  const amount = useDraftMoney(existing?.amount ?? '');
  const [frequency, setFrequency] = useState<Frequency>(existing?.frequency ?? 'monthly');
  const [startMonth, setStartMonth] = useState<MonthRef>(existing?.startMonth ?? nextMonth());
  const [label, setLabel] = useState(existing?.label ?? '');

  // Active schedules back the cancel op; only fetched when that op is selected.
  const { data: rawScheduled, isLoading } = trpc.scheduled.list.useQuery(undefined, {
    enabled: op === 'cancel',
  });
  const schedules = toArray(rawScheduled).filter((s) => s.isActive);

  function toggle(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const canSubmit = op === 'cancel' ? selectedIds.length > 0 : amount.isValid;

  function submit() {
    if (!canSubmit) return;

    if (op === 'cancel') {
      // One lever per checked schedule. Each add mints a fresh id so the panel
      // accumulates distinct levers; but when EDITING an existing single-select
      // cancel lever (value != null and exactly one selection), reuse its id so
      // the panel REPLACES it instead of appending an orphan.
      const reuseEditedId = value != null && selectedIds.length === 1;
      for (const id of selectedIds) {
        const sched = schedules.find((s) => s.id === id);
        const lever: SimLever = {
          kind: 'recurring_change',
          id: reuseEditedId ? leverEditorId(value) : crypto.randomUUID(),
          op: 'cancel',
          scheduledTransactionId: id,
          label: sched?.description ?? t('simulator.recurring.cancelDefaultLabel'),
        };
        onSubmit(lever);
      }
      return;
    }

    if (amount.normalized === null) return;
    const lever: SimLever = {
      kind: 'recurring_change',
      id: leverEditorId(value),
      op: 'add',
      amount: amount.normalized,
      frequency,
      startMonth,
      label: label.trim() || t('simulator.recurring.addDefaultLabel'),
    };
    onSubmit(lever);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t('simulator.leverKind.recurring_change')}</p>

      <div className="space-y-1.5">
        <Label htmlFor={opId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.operation')}
        </Label>
        <Select value={op} onValueChange={(v) => setOp((v ?? 'cancel') as RecurringOp)}>
          <SelectTrigger id={opId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RECURRING_OPS.map((o) => (
              <SelectItem key={o} value={o}>
                {t(`simulator.recurring.op.${o}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {op === 'cancel' && (
        <fieldset className="space-y-1.5">
          <legend className="text-xs text-muted-foreground">
            {t('simulator.recurring.selectSchedules')}
          </legend>
          {isLoading && (
            <p className="text-xs text-muted-foreground">{t('simulator.recurring.loading')}</p>
          )}
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-foreground/10 p-2">
            {schedules.map((s) => {
              const text = `${s.description} (${formatCurrency(toDisplayNumber(s.amount))})`;
              return (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(s.id)}
                    onChange={() => toggle(s.id)}
                    aria-label={text}
                  />
                  <span className="truncate">{text}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {op === 'add' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={labelId} className="text-xs text-muted-foreground">
              {t('simulator.leverField.label')}
            </Label>
            <Input id={labelId} value={label} onChange={(e) => setLabel(e.target.value)} />
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

          <MonthYearPicker
            id={`${opId}-start`}
            label={t('simulator.recurring.startMonth')}
            value={startMonth}
            onChange={setStartMonth}
            warnOnCurrentMonth
          />
        </>
      )}

      <LeverEditorFooter
        existing={value != null}
        canSubmit={canSubmit}
        onCancel={onCancel}
        onSubmit={submit}
      />
    </div>
  );
}
