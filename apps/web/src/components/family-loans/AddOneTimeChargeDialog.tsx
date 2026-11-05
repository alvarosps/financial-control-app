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

function getDefaultBillingMonth() {
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

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

export function AddOneTimeChargeDialog({ open, onOpenChange, configId, onSuccess }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const defaults = getDefaultBillingMonth();
  const [billingPeriod, setBillingPeriod] = useState(`${defaults.month}-${defaults.year}`);

  const monthOptions = buildMonthOptions(locale);

  const resetForm = () => {
    setDescription('');
    setAmount('');
    const d = getDefaultBillingMonth();
    setBillingPeriod(`${d.month}-${d.year}`);
  };

  const mutation = trpc.familyLoan.addOneTimeCharge.useMutation({
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
            {t('components-family-loans-addonetimechargedialog.oneTimeCharge')}
          </DialogTitle>
        </DialogHeader>
        <form
          {...formProps}
          onSubmit={(e) => {
            e.preventDefault();
            if (!description || !amount) return;
            const amountFormatted = toMoneyInputString(amount);
            if (!amountFormatted) {
              toast.error(t('components-family-loans-addonetimechargedialog.invalidAmount'));
              return;
            }

            const [mStr, yStr] = billingPeriod.split('-');
            const billingMonth = parseInt(mStr, 10);
            const billingYear = parseInt(yStr, 10);
            // Set date to the 15th of the billing month (arbitrary day within the month)
            const date = new Date(billingYear, billingMonth - 1, 15);

            mutation.mutate({
              configId,
              description: description.trim(),
              amount: amountFormatted,
              date,
              billingMonth,
              billingYear,
            });
          }}
          className="space-y-3"
        >
          <fieldset {...fieldsetProps} className="contents">
            <div>
              <Label htmlFor="pay-description" className="text-xs text-muted-foreground">
                {t('components-family-loans-addonetimechargedialog.description')}
              </Label>
              <Input
                id="pay-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('components-family-loans-addonetimechargedialog.eGCardPurchase')}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="pay-amount" className="text-xs text-muted-foreground">
                  {t('components-family-loans-addonetimechargedialog.amountR')}
                </Label>
                <Input
                  id="pay-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="pay-month" className="text-xs text-muted-foreground">
                  {t('components-family-loans-addonetimechargedialog.billingMonth')}
                </Label>
                <Select
                  value={billingPeriod}
                  onValueChange={(v) => setBillingPeriod(v ?? billingPeriod)}
                >
                  <SelectTrigger id="pay-month">
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
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                {t('components-family-loans-addonetimechargedialog.cancel')}
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
