'use client';

import { Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { getMonthName } from '@/lib/labels';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  configId: string;
  onSuccess: () => void;
};

function buildMonthOptions(locale: string) {
  const now = new Date();
  const options: { value: string; label: string }[] = [];
  for (let i = -1; i <= 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const m = d.getMonth() + 1;
    const y = d.getFullYear();
    options.push({
      value: `${m}-${y}`,
      label: `${getMonthName(m, locale)} ${y}`,
    });
  }
  return options;
}

export function AddInstallmentDialog({ open, onOpenChange, configId, onSuccess }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [total, setTotal] = useState('');
  const [currentInstallment, setCurrentInstallment] = useState('1');
  const [dueDay, setDueDay] = useState('');
  const now = new Date();
  const [billingPeriod, setBillingPeriod] = useState(`${now.getMonth() + 1}-${now.getFullYear()}`);

  const monthOptions = buildMonthOptions(locale);

  const resetForm = () => {
    setDescription('');
    setAmount('');
    setTotal('');
    setCurrentInstallment('1');
    setDueDay('');
    const d = new Date();
    setBillingPeriod(`${d.getMonth() + 1}-${d.getFullYear()}`);
  };

  const mutation = trpc.familyLoan.addInstallment.useMutation({
    onSuccess: () => {
      onSuccess();
      onOpenChange(false);
      resetForm();
    },
    onError: (error) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  });

  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard(mutation);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        if (!v) resetForm();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('components-family-loans-addinstallmentdialog.addInstallment')}
          </DialogTitle>
        </DialogHeader>
        <form
          {...formProps}
          onSubmit={(e) => {
            e.preventDefault();
            if (!description || !amount || !total || !dueDay) return;
            const amountFormatted = toMoneyInputString(amount);
            if (!amountFormatted) {
              toast.error(t('components-family-loans-addinstallmentdialog.invalidAmount'));
              return;
            }

            const [mStr, yStr] = billingPeriod.split('-');
            const billingMonth = parseInt(mStr, 10);
            const billingYear = parseInt(yStr, 10);

            mutation.mutate({
              configId,
              description: description.trim(),
              amount: amountFormatted,
              totalInstallments: parseInt(total, 10),
              currentInstallment: parseInt(currentInstallment, 10),
              dueDay: parseInt(dueDay, 10),
              billingMonth,
              billingYear,
            });
          }}
          className="space-y-3"
        >
          <fieldset {...fieldsetProps} className="contents">
            <div>
              <Label htmlFor="inst-description" className="text-xs text-muted-foreground">
                {t('components-family-loans-addinstallmentdialog.description')}
              </Label>
              <Input
                id="inst-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('components-family-loans-addinstallmentdialog.eGPhoneInstallments')}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="inst-amount" className="text-xs text-muted-foreground">
                  {t('components-family-loans-addinstallmentdialog.amountPerInstallmentR')}
                </Label>
                <Input
                  id="inst-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="inst-total" className="text-xs text-muted-foreground">
                  {t('components-family-loans-addinstallmentdialog.totalInstallments')}
                </Label>
                <Input
                  id="inst-total"
                  type="number"
                  min="1"
                  value={total}
                  onChange={(e) => setTotal(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="inst-current" className="text-xs text-muted-foreground">
                  {t('components-family-loans-addinstallmentdialog.currentInstallment')}
                </Label>
                <Input
                  id="inst-current"
                  type="number"
                  min="0"
                  value={currentInstallment}
                  onChange={(e) => setCurrentInstallment(e.target.value)}
                  required
                />
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {t('components-family-loans-addinstallmentdialog.0StartsNextMonth')}
                </p>
              </div>
              <div>
                <Label htmlFor="inst-due-day" className="text-xs text-muted-foreground">
                  {t('components-family-loans-addinstallmentdialog.dueDay')}
                </Label>
                <Input
                  id="inst-due-day"
                  type="number"
                  min="1"
                  max="31"
                  value={dueDay}
                  onChange={(e) => setDueDay(e.target.value)}
                  required
                />
              </div>
            </div>
            <div>
              <Label htmlFor="inst-billing" className="text-xs text-muted-foreground">
                {t('components-family-loans-addinstallmentdialog.referenceMonth')}
              </Label>
              <Select
                value={billingPeriod}
                onValueChange={(v) => setBillingPeriod(v ?? billingPeriod)}
              >
                <SelectTrigger id="inst-billing">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {monthOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {t('components-family-loans-addinstallmentdialog.monthWhenTheCurrent')}
              </p>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                {t('components-family-loans-addinstallmentdialog.cancel')}
              </Button>
              <Button type="submit" {...submitProps}>
                {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                {isPending ? t('common.adding') : t('common.add')}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
