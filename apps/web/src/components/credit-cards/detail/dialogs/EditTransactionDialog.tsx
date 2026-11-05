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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { toDateInputValue } from '@/lib/dates';
import { invalidateCreditCardContext } from '@/lib/invalidate';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';

export type EditableTransaction = {
  id: string;
  description: string;
  amount: string | number;
  categoryId: string | null;
  date: string | Date;
  domainType: string | null;
  isPaid: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: EditableTransaction | null;
  categories: { id: string; name: string }[];
};

const NO_CATEGORY = '__none__';

export function EditTransactionDialog({ open, onOpenChange, transaction, categories }: Props) {
  const t = useTranslations();
  const isRefund = transaction?.domainType === 'credit_card_refund';
  const isPaidExpense = !isRefund && !!transaction?.isPaid;

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState<string>(NO_CATEGORY);
  const [date, setDate] = useState('');

  useEffect(() => {
    if (open && transaction) {
      setDescription(transaction.description);
      setAmount(String(transaction.amount));
      setCategoryId(transaction.categoryId ?? NO_CATEGORY);
      setDate(toDateInputValue(transaction.date));
    }
  }, [open, transaction]);

  const utils = trpc.useUtils();
  const update = trpc.transaction.update.useMutation({
    onSuccess: async () => {
      await invalidateCreditCardContext(utils);
      toast.success(t('components-credit-cards-detail-dialogs-edittransactiondialog.success'));
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  });

  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard(update);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!transaction || !description.trim()) return;
    const parsedAmount = toMoneyInputString(amount);
    if (!parsedAmount) {
      toast.error(t('common.saveFailed'));
      return;
    }
    update.mutate({
      id: transaction.id,
      description: description.trim(),
      // A paid expense keeps its amount; omit so the server doesn't reject it.
      ...(!isPaidExpense && { amount: parsedAmount }),
      ...(!isRefund && { categoryId: categoryId === NO_CATEGORY ? null : categoryId }),
      ...(!isRefund && date && { date: new Date(date) }),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isRefund
              ? t('components-credit-cards-detail-dialogs-edittransactiondialog.titleRefund')
              : t('components-credit-cards-detail-dialogs-edittransactiondialog.titleExpense')}
          </DialogTitle>
        </DialogHeader>
        <form {...formProps} onSubmit={handleSubmit} className="space-y-3">
          <fieldset {...fieldsetProps} className="contents">
            <div>
              <Label htmlFor="edit-tx-description" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-edittransactiondialog.descriptionLabel')}
              </Label>
              <Input
                id="edit-tx-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="edit-tx-amount" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-edittransactiondialog.amountLabel')}
              </Label>
              <Input
                id="edit-tx-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={isPaidExpense}
                required
              />
              {isPaidExpense && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t(
                    'components-credit-cards-detail-dialogs-edittransactiondialog.paidAmountLocked',
                  )}
                </p>
              )}
            </div>
            {!isRefund && (
              <>
                <div>
                  <Label htmlFor="edit-tx-category" className="text-xs text-muted-foreground">
                    {t(
                      'components-credit-cards-detail-dialogs-edittransactiondialog.categoryLabel',
                    )}
                  </Label>
                  <Select value={categoryId} onValueChange={(v) => setCategoryId(v ?? NO_CATEGORY)}>
                    <SelectTrigger id="edit-tx-category">
                      <SelectValue placeholder={t('common.selectCategory')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_CATEGORY}>
                        {t(
                          'components-credit-cards-detail-dialogs-edittransactiondialog.noCategory',
                        )}
                      </SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="edit-tx-date" className="text-xs text-muted-foreground">
                    {t('components-credit-cards-detail-dialogs-edittransactiondialog.dateLabel')}
                  </Label>
                  <Input
                    id="edit-tx-date"
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </div>
              </>
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
              <Button type="submit" {...submitProps}>
                {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                {isPending ? t('common.saving') : t('common.save')}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
