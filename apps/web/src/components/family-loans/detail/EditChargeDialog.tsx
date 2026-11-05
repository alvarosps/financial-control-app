'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
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
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { dateInputToDate, toDateInputValue } from '@/lib/dates';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';

export type EditChargeTarget = {
  scheduledTransactionId: string;
  description: string;
  amount: string;
  domainType: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EditChargeTarget | null;
  billMonth: number;
  billYear: number;
  onSuccess: () => void;
};

function dateForBillPeriod(year: number, month: number, dueDay: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Math.max(dueDay, 1), lastDay);
  return toDateInputValue(new Date(Date.UTC(year, month - 1, day)));
}

export function EditChargeDialog({
  open,
  onOpenChange,
  target,
  billMonth,
  billYear,
  onSuccess,
}: Props) {
  const t = useTranslations();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [installmentDiscount, setInstallmentDiscount] = useState(false);
  const [currentInstallment, setCurrentInstallment] = useState('');
  const [totalInstallments, setTotalInstallments] = useState('');
  const [dueDay, setDueDay] = useState('');

  const scheduleQuery = trpc.scheduled.getById.useQuery(
    { id: target?.scheduledTransactionId ?? '' },
    { enabled: open && !!target?.scheduledTransactionId },
  );
  const schedule = scheduleQuery.data;
  const isInstallment = schedule?.domainType === 'family_loan_installment';
  const isExpense = schedule?.domainType === 'family_loan_expense';
  const isDiscount = schedule?.domainType === 'family_loan_discount';
  const showInstallmentFields = isInstallment || (isDiscount && installmentDiscount);

  useEffect(() => {
    if (!open || !target || !schedule) return;
    setDescription(target.description);
    const parsed = Number.parseFloat(target.amount);
    setAmount(Number.isNaN(parsed) ? '' : String(parsed));
    setCurrentInstallment(
      target.installmentNumber != null ? String(target.installmentNumber) : '1',
    );
    setTotalInstallments(
      target.totalInstallments != null
        ? String(target.totalInstallments)
        : String(schedule.totalOccurrences ?? ''),
    );
    const recurringDiscount =
      schedule.domainType === 'family_loan_discount' && schedule.frequency === 'monthly';
    setInstallmentDiscount(recurringDiscount);
    setDueDay(String(schedule.dueDay ?? 1));
    setDate(
      recurringDiscount
        ? dateForBillPeriod(billYear, billMonth, schedule.dueDay ?? 1)
        : toDateInputValue(schedule.startDate),
    );
  }, [billMonth, billYear, open, schedule, target]);

  const handleSuccess = () => {
    onSuccess();
    onOpenChange(false);
  };
  const editInstallment = trpc.familyLoan.editInstallment.useMutation({
    onSuccess: handleSuccess,
    onError: (error) => toast.error(error.message || t('common.saveFailed')),
  });
  const editAdjustment = trpc.familyLoan.editAdjustment.useMutation({
    onSuccess: handleSuccess,
    onError: (error) => toast.error(error.message || t('common.saveFailed')),
  });
  const isPending = editInstallment.isPending || editAdjustment.isPending;
  const { fieldsetProps, formProps } = useMutationFormGuard({ isPending });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!target || !schedule || !description.trim()) return;
    const parsedAmount = toMoneyInputString(amount);
    if (!parsedAmount) {
      toast.error(t('components-family-loans-detail-editchargedialog.invalidValues'));
      return;
    }

    if (isInstallment) {
      const parsedCurrent = Number.parseInt(currentInstallment, 10);
      const parsedTotal = Number.parseInt(totalInstallments, 10);
      if (
        Number.isNaN(parsedCurrent) ||
        Number.isNaN(parsedTotal) ||
        parsedCurrent < 1 ||
        parsedCurrent > parsedTotal
      ) {
        toast.error(t('components-family-loans-detail-editchargedialog.invalidValues'));
        return;
      }
      editInstallment.mutate({
        scheduleId: target.scheduledTransactionId,
        description: description.trim(),
        amount: parsedAmount,
        totalInstallments: parsedTotal,
        currentInstallment: parsedCurrent,
        currentBillingMonth: billMonth,
        currentBillingYear: billYear,
      });
      return;
    }

    if ((!isExpense && !isDiscount) || !date) return;
    const adjustmentInput = {
      scheduleId: target.scheduledTransactionId,
      description: description.trim(),
      amount: parsedAmount,
      date: dateInputToDate(date),
    };
    if (isDiscount && installmentDiscount) {
      const parsedCurrent = Number.parseInt(currentInstallment, 10);
      const parsedTotal = Number.parseInt(totalInstallments, 10);
      const parsedDueDay = Number.parseInt(dueDay, 10);
      if (
        Number.isNaN(parsedCurrent) ||
        Number.isNaN(parsedTotal) ||
        Number.isNaN(parsedDueDay) ||
        parsedCurrent < 1 ||
        parsedCurrent > parsedTotal ||
        parsedTotal < 2 ||
        parsedDueDay < 1 ||
        parsedDueDay > 31
      ) {
        toast.error(t('components-family-loans-detail-editchargedialog.invalidValues'));
        return;
      }
      editAdjustment.mutate({
        ...adjustmentInput,
        currentInstallment: parsedCurrent,
        totalInstallments: parsedTotal,
        dueDay: parsedDueDay,
      });
      return;
    }
    editAdjustment.mutate(adjustmentInput);
  }

  const title = isExpense
    ? t('components-family-loans-detail-editchargedialog.expenseTitle')
    : isDiscount
      ? t('components-family-loans-detail-editchargedialog.discountTitle')
      : t('components-family-loans-detail-editchargedialog.installmentTitle');

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {scheduleQuery.isLoading ? (
          <div className="flex min-h-32 items-center justify-center" aria-live="polite">
            <Loader2 className="size-5 animate-spin" aria-hidden />
            <span className="sr-only">
              {t('components-family-loans-detail-editchargedialog.loading')}
            </span>
          </div>
        ) : scheduleQuery.error || !schedule ? (
          <div className="space-y-4">
            <p className="text-sm text-expense" role="alert">
              {t('components-family-loans-detail-editchargedialog.loadError')}
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.close')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form {...formProps} onSubmit={handleSubmit} className="space-y-3">
            <fieldset {...fieldsetProps} className="contents">
              <div>
                <Label htmlFor="edit-charge-description">
                  {t('components-family-loans-detail-editchargedialog.description')}
                </Label>
                <Input
                  id="edit-charge-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="edit-charge-amount">
                  {t('components-family-loans-detail-editchargedialog.amount')}
                </Label>
                <Input
                  id="edit-charge-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  required
                />
              </div>
              {(isExpense || isDiscount) && (
                <div>
                  <Label htmlFor="edit-charge-date">
                    {t('components-family-loans-detail-editchargedialog.date')}
                  </Label>
                  <Input
                    id="edit-charge-date"
                    type="date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                    required
                  />
                </div>
              )}
              {isDiscount && (
                <label
                  htmlFor="edit-charge-installment"
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    id="edit-charge-installment"
                    type="checkbox"
                    checked={installmentDiscount}
                    onChange={(event) => setInstallmentDiscount(event.target.checked)}
                  />
                  {t('components-family-loans-detail-editchargedialog.installmentDiscount')}
                </label>
              )}
              {showInstallmentFields && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="edit-charge-current">
                      {t('components-family-loans-detail-editchargedialog.currentInstallment')}
                    </Label>
                    <Input
                      id="edit-charge-current"
                      type="number"
                      min="1"
                      value={currentInstallment}
                      onChange={(event) => setCurrentInstallment(event.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="edit-charge-total">
                      {t('components-family-loans-detail-editchargedialog.totalInstallments')}
                    </Label>
                    <Input
                      id="edit-charge-total"
                      type="number"
                      min={isDiscount ? 2 : 1}
                      value={totalInstallments}
                      onChange={(event) => setTotalInstallments(event.target.value)}
                      required
                    />
                  </div>
                </div>
              )}
              {isDiscount && installmentDiscount && (
                <div>
                  <Label htmlFor="edit-charge-due-day">
                    {t('components-family-loans-detail-editchargedialog.dueDay')}
                  </Label>
                  <Input
                    id="edit-charge-due-day"
                    type="number"
                    min="1"
                    max="31"
                    value={dueDay}
                    onChange={(event) => setDueDay(event.target.value)}
                    required
                  />
                </div>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => onOpenChange(false)}
                  disabled={isPending}
                >
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={isPending} aria-busy={isPending}>
                  {isPending && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
                  {isPending ? t('common.saving') : t('common.save')}
                </Button>
              </DialogFooter>
            </fieldset>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
