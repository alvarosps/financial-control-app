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
import { trpc } from '@/lib/trpc/client';
import { LeverEditorFooter } from './LeverEditorFooter';
import { type LeverEditorProps, leverEditorId, nextMonth } from './lever-options';
import { MonthYearPicker } from './MonthYearPicker';
import { useDraftMoney } from './use-draft-money';

/**
 * Editor for a `loan_payoff` lever. The loan picker is sourced from
 * `trpc.loan.list` and filtered to loans that have a `config` — only those are
 * valid payoff targets (the resolver requires a loan_config). The optional
 * partial-amount field uses {@link useDraftMoney} (left blank = full payoff;
 * any entered value is normalized to the canonical money string the API
 * expects). `targetMonth` defaults to {@link nextMonth} for a fresh lever — a
 * `targetMonth` in the current month or earlier is a resolver no-op, so a newly
 * added payoff must start one month ahead to be valid by default.
 */
export function LoanPayoffLeverEditor({ value, onSubmit, onCancel }: LeverEditorProps) {
  const t = useTranslations();
  const loanId = useId();
  const partialId = useId();
  const existing = value?.kind === 'loan_payoff' ? value : null;

  const { data: loans } = trpc.loan.list.useQuery();
  const options = (loans ?? []).filter((l) => l.config);

  const [loanAccountId, setLoanAccountId] = useState(existing?.loanAccountId ?? '');
  const [targetMonth, setTargetMonth] = useState<MonthRef>(existing?.targetMonth ?? nextMonth());
  const partial = useDraftMoney(existing?.partialAmount ?? '');

  // The partial amount is optional (blank = full payoff). When provided it must
  // be a valid positive money string, so block submit on a non-empty-but-invalid
  // draft; an empty draft stays valid.
  const partialOk = partial.value.trim() === '' || partial.isValid;
  const canSubmit = loanAccountId !== '' && partialOk;

  function submit() {
    if (!canSubmit) return;
    const lever: SimLever = {
      kind: 'loan_payoff',
      id: leverEditorId(value),
      loanAccountId,
      targetMonth,
      ...(partial.normalized === null ? {} : { partialAmount: partial.normalized }),
    };
    onSubmit(lever);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t('simulator.leverKind.loan_payoff')}</p>

      <div className="space-y-1.5">
        <Label htmlFor={loanId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.loan')}
        </Label>
        <Select value={loanAccountId} onValueChange={(v) => setLoanAccountId(v ?? '')}>
          <SelectTrigger id={loanId} className="w-full">
            <SelectValue placeholder={t('simulator.leverEditor.selectLoanPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {options.map((l) => (
              <SelectItem key={l.account.id} value={l.account.id}>
                {l.account.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <MonthYearPicker
        id={`${loanId}-month`}
        label={t('simulator.leverField.targetMonth')}
        value={targetMonth}
        onChange={setTargetMonth}
        warnOnCurrentMonth
      />

      <div className="space-y-1.5">
        <Label htmlFor={partialId} className="text-xs text-muted-foreground">
          {t('simulator.leverField.partialAmount')}
        </Label>
        <Input
          id={partialId}
          inputMode="decimal"
          placeholder={t('simulator.leverEditor.partialPlaceholder')}
          value={partial.value}
          onChange={(e) => partial.setValue(e.target.value)}
        />
      </div>

      <LeverEditorFooter
        existing={value != null}
        canSubmit={canSubmit}
        onCancel={onCancel}
        onSubmit={submit}
      />
    </div>
  );
}
