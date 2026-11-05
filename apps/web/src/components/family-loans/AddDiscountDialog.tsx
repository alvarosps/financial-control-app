'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  configId: string;
  onSuccess: () => void;
};

export function AddDiscountDialog({ open, onOpenChange, configId, onSuccess }: Props) {
  const t = useTranslations();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [isInstallment, setIsInstallment] = useState(false);
  const [total, setTotal] = useState('');
  const [currentInstallment, setCurrentInstallment] = useState('1');
  const [dueDay, setDueDay] = useState('');

  const resetForm = () => {
    setDescription('');
    setAmount('');
    setDate('');
    setIsInstallment(false);
    setTotal('');
    setCurrentInstallment('1');
    setDueDay('');
  };

  const mutation = trpc.familyLoan.addDiscount.useMutation({
    onSuccess: () => {
      onSuccess();
      onOpenChange(false);
      setDescription('');
      setAmount('');
      setDate('');
      setIsInstallment(false);
      setTotal('');
      setCurrentInstallment('1');
      setDueDay('');
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
          <DialogTitle>{t('components-family-loans-adddiscountdialog.addDiscount')}</DialogTitle>
        </DialogHeader>
        <form
          {...formProps}
          onSubmit={(e) => {
            e.preventDefault();
            if (!description || !amount || !date) return;
            if (isInstallment && (!total || !dueDay)) return;
            const amountFormatted = toMoneyInputString(amount);
            if (!amountFormatted) {
              toast.error(t('components-family-loans-adddiscountdialog.invalidAmount'));
              return;
            }
            if (isInstallment) {
              const totalParsed = parseInt(total, 10);
              const currentParsed = parseInt(currentInstallment, 10);
              if (Number.isNaN(totalParsed) || Number.isNaN(currentParsed) || currentParsed < 1) {
                toast.error(t('components-family-loans-adddiscountdialog.invalidInstallments'));
                return;
              }
              if (currentParsed > totalParsed) {
                toast.error(t('components-family-loans-adddiscountdialog.currentExceedsTotal'));
                return;
              }
            }
            mutation.mutate({
              configId,
              description: description.trim(),
              amount: amountFormatted,
              date: new Date(date),
              ...(isInstallment && {
                totalInstallments: parseInt(total, 10),
                currentInstallment: parseInt(currentInstallment, 10),
                dueDay: parseInt(dueDay, 10),
              }),
            });
          }}
          className="space-y-3"
        >
          <fieldset {...fieldsetProps} className="contents">
            <div>
              <Label htmlFor="disc-description" className="text-xs text-muted-foreground">
                {t('components-family-loans-adddiscountdialog.description')}
              </Label>
              <Input
                id="disc-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('components-family-loans-adddiscountdialog.eGAgreedDiscount')}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="disc-amount" className="text-xs text-muted-foreground">
                  {t('components-family-loans-adddiscountdialog.amountR')}
                </Label>
                <Input
                  id="disc-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="disc-date" className="text-xs text-muted-foreground">
                  {isInstallment
                    ? t('shared.installments.startDate')
                    : t('shared.installments.date')}
                </Label>
                <Input
                  id="disc-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="disc-installment"
                checked={isInstallment}
                onChange={(e) => setIsInstallment(e.target.checked)}
                className="rounded border-border"
              />
              <Label htmlFor="disc-installment" className="text-sm text-muted-foreground">
                {t('components-family-loans-adddiscountdialog.splitDiscountIntoInstallments')}
              </Label>
            </div>
            {isInstallment && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label htmlFor="disc-total" className="text-xs text-muted-foreground">
                    {t('components-family-loans-adddiscountdialog.totalInstallments')}
                  </Label>
                  <Input
                    id="disc-total"
                    type="number"
                    min="1"
                    value={total}
                    onChange={(e) => setTotal(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="disc-starting" className="text-xs text-muted-foreground">
                    {t('components-family-loans-adddiscountdialog.currentInstallmentLabel')}
                  </Label>
                  <Input
                    id="disc-starting"
                    type="number"
                    min="1"
                    value={currentInstallment}
                    onChange={(e) => setCurrentInstallment(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="disc-due-day" className="text-xs text-muted-foreground">
                    {t('components-family-loans-adddiscountdialog.dueDay')}
                  </Label>
                  <Input
                    id="disc-due-day"
                    type="number"
                    min="1"
                    max="31"
                    value={dueDay}
                    onChange={(e) => setDueDay(e.target.value)}
                    required
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                {t('components-family-loans-adddiscountdialog.cancel')}
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
