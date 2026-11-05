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
import { invalidateCreditCardContext } from '@/lib/invalidate';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cardId: string;
  defaultSourceAccountId: string;
  billMonth: number;
  billYear: number;
};

export function AddRefundDialog({
  open,
  onOpenChange,
  cardId,
  defaultSourceAccountId,
  billMonth,
  billYear,
}: Props) {
  const t = useTranslations();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');

  const utils = trpc.useUtils();
  const create = trpc.creditCard.addRefund.useMutation({
    onSuccess: async () => {
      await invalidateCreditCardContext(utils);
      setDescription('');
      setAmount('');
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  });

  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard(create);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsedAmount = toMoneyInputString(amount);
    if (!description.trim() || !parsedAmount) {
      if (amount && !parsedAmount)
        toast.error(t('components-credit-cards-detail-dialogs-addrefunddialog.invalidAmount'));
      return;
    }

    create.mutate({
      expenseAccountId: defaultSourceAccountId,
      creditCardAccountId: cardId,
      amount: parsedAmount,
      description: description.trim(),
      refundDate: new Date(),
      billingMonth: billMonth,
      billingYear: billYear,
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        if (!v) {
          setDescription('');
          setAmount('');
        }
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('components-credit-cards-detail-dialogs-addrefunddialog.addRefund')}
          </DialogTitle>
        </DialogHeader>
        <form {...formProps} onSubmit={handleSubmit} className="space-y-3">
          <fieldset {...fieldsetProps} className="contents">
            <div>
              <Label htmlFor="refund-description" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-addrefunddialog.description')}
              </Label>
              <Input
                id="refund-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t(
                  'components-credit-cards-detail-dialogs-addrefunddialog.eGAmazonRefund',
                )}
                required
              />
            </div>
            <div>
              <Label htmlFor="refund-amount" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-addrefunddialog.amountR')}
              </Label>
              <Input
                id="refund-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
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
                {t('components-credit-cards-detail-dialogs-addrefunddialog.cancel')}
              </Button>
              <Button type="submit" {...submitProps}>
                {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                {isPending ? t('common.saving') : t('common.add')}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
