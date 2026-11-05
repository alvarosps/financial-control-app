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

export function AddFixedChargeDialog({ open, onOpenChange, configId, onSuccess }: Props) {
  const t = useTranslations();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [startDate, setStartDate] = useState('');

  const resetForm = () => {
    setDescription('');
    setAmount('');
    setDueDay('');
    setStartDate('');
  };

  const mutation = trpc.familyLoan.addFixedCharge.useMutation({
    onSuccess: () => {
      onSuccess();
      onOpenChange(false);
      setDescription('');
      setAmount('');
      setDueDay('');
      setStartDate('');
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
            {t('components-family-loans-addfixedchargedialog.addFixedCharge')}
          </DialogTitle>
        </DialogHeader>
        <form
          {...formProps}
          onSubmit={(e) => {
            e.preventDefault();
            if (!description || !amount || !dueDay || !startDate) return;
            const amountFormatted = toMoneyInputString(amount);
            if (!amountFormatted) {
              toast.error(t('components-family-loans-addfixedchargedialog.invalidAmount'));
              return;
            }
            mutation.mutate({
              configId,
              description: description.trim(),
              amount: amountFormatted,
              dueDay: parseInt(dueDay, 10),
              startDate: new Date(startDate),
            });
          }}
          className="space-y-3"
        >
          <fieldset {...fieldsetProps} className="contents">
            <div>
              <Label htmlFor="fixed-description" className="text-xs text-muted-foreground">
                {t('components-family-loans-addfixedchargedialog.description')}
              </Label>
              <Input
                id="fixed-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('components-family-loans-addfixedchargedialog.eGMonthlyRent')}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="fixed-amount" className="text-xs text-muted-foreground">
                  {t('components-family-loans-addfixedchargedialog.amountR')}
                </Label>
                <Input
                  id="fixed-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="fixed-due-day" className="text-xs text-muted-foreground">
                  {t('components-family-loans-addfixedchargedialog.dueDay')}
                </Label>
                <Input
                  id="fixed-due-day"
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
              <Label htmlFor="fixed-start-date" className="text-xs text-muted-foreground">
                {t('components-family-loans-addfixedchargedialog.startDate')}
              </Label>
              <Input
                id="fixed-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                {t('components-family-loans-addfixedchargedialog.cancel')}
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
