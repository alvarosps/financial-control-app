'use client';

import { Money } from '@fc/domain';
import type { LoanPaymentMethod } from '@fc/shared';
import Decimal from 'decimal.js';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MoneyField } from '@/components/shared/MoneyField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toMoneyInputString } from '@/lib/money';
import { LoanPaymentMethodFields } from '../LoanPaymentMethodFields';

export type EditLoanForm = {
  name: string;
  monthlyPayment: string;
  dueDay: string;
  comment: string;
  paymentMethod: LoanPaymentMethod | null;
  incomeSourceAccountId: string | null;
  annualCetPercent: string;
  annualCetSource: string;
  annualCetObservedOn: string;
  payoffQuoteAmount: string;
  payoffQuoteOn: string;
  payoffQuoteValidUntil: string;
  payoffQuoteSource: string;
  economicResponsibility: 'unknown' | 'own' | 'family' | 'work' | 'property';
};

export const EMPTY_EDIT_LOAN_FORM: EditLoanForm = {
  name: '',
  monthlyPayment: '',
  dueDay: '',
  comment: '',
  paymentMethod: null,
  incomeSourceAccountId: null,
  annualCetPercent: '',
  annualCetSource: '',
  annualCetObservedOn: '',
  payoffQuoteAmount: '',
  payoffQuoteOn: '',
  payoffQuoteValidUntil: '',
  payoffQuoteSource: '',
  economicResponsibility: 'unknown',
};

export function costEvidenceFromForm(form: EditLoanForm) {
  const rate = form.annualCetPercent.trim().replace(',', '.');
  const amount = form.payoffQuoteAmount.trim().includes(',')
    ? form.payoffQuoteAmount.trim().replaceAll('.', '').replace(',', '.')
    : form.payoffQuoteAmount.trim();
  if (
    rate &&
    (!/^\d{1,4}(\.\d{1,6})?$/.test(rate) ||
      new Decimal(rate).gte(10000) ||
      !form.annualCetSource.trim() ||
      !form.annualCetObservedOn)
  )
    throw new Error('Incomplete CET');
  if (
    amount &&
    (!/^\d{1,10}(\.\d{1,2})?$/.test(amount) ||
      !Money.fromString(amount, 'BRL').isPositive() ||
      !form.payoffQuoteSource.trim() ||
      !form.payoffQuoteOn ||
      form.payoffQuoteValidUntil < form.payoffQuoteOn)
  )
    throw new Error('Incomplete quote');
  return {
    annualCet: rate
      ? {
          rate: new Decimal(rate).div(100).toFixed(8),
          source: form.annualCetSource.trim(),
          observedOn: form.annualCetObservedOn,
        }
      : null,
    payoffQuote: amount
      ? {
          amount: Money.fromString(amount, 'BRL').toDbString(),
          quotedOn: form.payoffQuoteOn,
          validUntil: form.payoffQuoteValidUntil,
          source: form.payoffQuoteSource.trim(),
        }
      : null,
    economicResponsibility: form.economicResponsibility,
  };
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: EditLoanForm;
  setForm: (f: EditLoanForm) => void;
  placeholderName: string;
  isPending: boolean;
  onSubmit: (payload: {
    name?: string;
    monthlyPayment?: string;
    dueDay?: number;
    comment: string | null;
    paymentMethod: LoanPaymentMethod | null;
    incomeSourceAccountId: string | null;
    costEvidence: ReturnType<typeof costEvidenceFromForm>;
  }) => void;
};

export function EditLoanDialog({
  open,
  onOpenChange,
  form,
  setForm,
  placeholderName,
  isPending,
  onSubmit,
}: Props) {
  const t = useTranslations();

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setForm(EMPTY_EDIT_LOAN_FORM);
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('app-dashboard-loans-id-page.editLoan')}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const paymentFormatted = form.monthlyPayment
              ? toMoneyInputString(form.monthlyPayment)
              : null;
            if (form.monthlyPayment && !paymentFormatted) {
              toast.error(t('app-dashboard-loans-id-page.invalidAmount'));
              return;
            }
            const dueParsed = form.dueDay ? parseInt(form.dueDay, 10) : null;
            let costEvidence: ReturnType<typeof costEvidenceFromForm>;
            try {
              costEvidence = costEvidenceFromForm(form);
            } catch {
              toast.error(t('loanCost.invalidEvidence'));
              return;
            }
            onSubmit({
              costEvidence,
              ...(form.name.trim() ? { name: form.name.trim() } : {}),
              ...(paymentFormatted ? { monthlyPayment: paymentFormatted } : {}),
              ...(dueParsed != null && !Number.isNaN(dueParsed) ? { dueDay: dueParsed } : {}),
              comment: form.comment.trim() || null,
              paymentMethod: form.paymentMethod,
              incomeSourceAccountId: form.incomeSourceAccountId,
            });
          }}
          className="space-y-3"
          aria-busy={isPending}
        >
          <fieldset disabled={isPending} aria-busy={isPending} className="contents">
            <div>
              <Label htmlFor="edit-loan-name" className="text-xs text-muted-foreground">
                {t('app-dashboard-loans-id-page.name')}
              </Label>
              <Input
                id="edit-loan-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={placeholderName}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label
                  htmlFor="edit-loan-monthly-payment"
                  className="text-xs text-muted-foreground"
                >
                  {t('app-dashboard-loans-id-page.monthlyInstallmentR')}
                </Label>
                <Input
                  id="edit-loan-monthly-payment"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={form.monthlyPayment}
                  onChange={(e) => setForm({ ...form, monthlyPayment: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="edit-loan-due-day" className="text-xs text-muted-foreground">
                  {t('components-loans-detail-editloandialog.dueDay')}
                </Label>
                <Input
                  id="edit-loan-due-day"
                  type="number"
                  min="1"
                  max="31"
                  value={form.dueDay}
                  onChange={(e) => setForm({ ...form, dueDay: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="edit-loan-comment" className="text-xs text-muted-foreground">
                {t('app-dashboard-loans-id-page.comment')}
              </Label>
              <Input
                id="edit-loan-comment"
                value={form.comment}
                onChange={(e) => setForm({ ...form, comment: e.target.value })}
                placeholder={t('components-loans-detail-editloandialog.optional')}
              />
            </div>
            <LoanPaymentMethodFields
              method={form.paymentMethod}
              sourceId={form.incomeSourceAccountId}
              onChange={(paymentMethod, incomeSourceAccountId) =>
                setForm({ ...form, paymentMethod, incomeSourceAccountId })
              }
            />
            <p className="text-xs text-muted-foreground">{t('loanCost.editHint')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="loan-cet">{t('loanCost.cet')}</Label>
                <Input
                  id="loan-cet"
                  inputMode="decimal"
                  value={form.annualCetPercent}
                  onChange={(e) => setForm({ ...form, annualCetPercent: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="loan-cet-source">{t('loanCost.cetSource')}</Label>
                <Input
                  id="loan-cet-source"
                  maxLength={200}
                  required={!!form.annualCetPercent}
                  value={form.annualCetSource}
                  onChange={(e) => setForm({ ...form, annualCetSource: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="loan-cet-date">{t('loanCost.cetDate')}</Label>
                <Input
                  id="loan-cet-date"
                  type="date"
                  required={!!form.annualCetPercent}
                  value={form.annualCetObservedOn}
                  onChange={(e) => setForm({ ...form, annualCetObservedOn: e.target.value })}
                />
              </div>
              <MoneyField
                id="loan-quote"
                label={t('loanCost.quoteAmount')}
                value={form.payoffQuoteAmount}
                onChange={(payoffQuoteAmount) => setForm({ ...form, payoffQuoteAmount })}
              />
              <div>
                <Label htmlFor="loan-quote-source">{t('loanCost.quoteSource')}</Label>
                <Input
                  id="loan-quote-source"
                  maxLength={200}
                  required={!!form.payoffQuoteAmount}
                  value={form.payoffQuoteSource}
                  onChange={(e) => setForm({ ...form, payoffQuoteSource: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="loan-quote-date">{t('loanCost.quoteDate')}</Label>
                <Input
                  id="loan-quote-date"
                  type="date"
                  required={!!form.payoffQuoteAmount}
                  value={form.payoffQuoteOn}
                  onChange={(e) => setForm({ ...form, payoffQuoteOn: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="loan-quote-validity">{t('loanCost.quoteValidity')}</Label>
                <Input
                  id="loan-quote-validity"
                  type="date"
                  min={form.payoffQuoteOn}
                  required={!!form.payoffQuoteAmount}
                  value={form.payoffQuoteValidUntil}
                  onChange={(e) => setForm({ ...form, payoffQuoteValidUntil: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="loan-responsibility">{t('loanCost.responsibilityLabel')}</Label>
                <select
                  id="loan-responsibility"
                  className="border rounded-md p-2 w-full"
                  value={form.economicResponsibility}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      economicResponsibility: e.target
                        .value as EditLoanForm['economicResponsibility'],
                    })
                  }
                >
                  {(['unknown', 'own', 'family', 'work', 'property'] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(`loanCost.responsibilities.${value}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => {
                  setForm(EMPTY_EDIT_LOAN_FORM);
                  onOpenChange(false);
                }}
                disabled={isPending}
              >
                {t('app-dashboard-loans-id-page.cancel')}
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? t('common.saving') : t('common.save')}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
