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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { invalidateCreditCardContext } from '@/lib/invalidate';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cardId: string;
  defaultSourceAccountId: string;
  closingDay: number;
  dueDay: number;
  categories: { id: string; name: string }[];
};

export function AddInstallmentDialog({
  open,
  onOpenChange,
  cardId,
  defaultSourceAccountId,
  categories,
}: Props) {
  const t = useTranslations();
  const now = new Date();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [totalInstallments, setTotalInstallments] = useState('12');
  const [currentInstallmentNumber, setCurrentInstallmentNumber] = useState('1');
  const [currentBillingMonth, setCurrentBillingMonth] = useState(String(now.getMonth() + 1));
  const [currentBillingYear, setCurrentBillingYear] = useState(String(now.getFullYear()));
  const [categoryId, setCategoryId] = useState('');

  const utils = trpc.useUtils();
  const addInstallment = trpc.creditCard.addInstallment.useMutation({
    onSuccess: async () => {
      await invalidateCreditCardContext(utils);
      resetForm();
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  });

  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard(addInstallment);

  function resetForm() {
    setDescription('');
    setAmount('');
    setTotalInstallments('12');
    setCurrentInstallmentNumber('1');
    setCurrentBillingMonth(String(new Date().getMonth() + 1));
    setCurrentBillingYear(String(new Date().getFullYear()));
    setCategoryId('');
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim() || !amount) return;

    const amountFormatted = toMoneyInputString(amount);
    if (!amountFormatted) {
      toast.error(t('components-credit-cards-detail-dialogs-addinstallmentdialog.invalidAmount'));
      return;
    }

    const currentInst = parseInt(currentInstallmentNumber, 10);
    const total = parseInt(totalInstallments, 10);
    const curMonth = parseInt(currentBillingMonth, 10);
    const curYear = parseInt(currentBillingYear, 10);
    if (
      Number.isNaN(currentInst) ||
      Number.isNaN(total) ||
      currentInst < 1 ||
      currentInst > total ||
      total < 1 ||
      Number.isNaN(curMonth) ||
      curMonth < 1 ||
      curMonth > 12 ||
      Number.isNaN(curYear)
    )
      return;

    addInstallment.mutate({
      creditCardAccountId: cardId,
      expenseAccountId: defaultSourceAccountId,
      amount: amountFormatted,
      description: description.trim(),
      totalInstallments: total,
      currentInstallmentNumber: currentInst,
      currentBillingMonth: curMonth,
      currentBillingYear: curYear,
      ...(categoryId && { categoryId }),
    });
  }

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
            {t('components-credit-cards-detail-dialogs-addinstallmentdialog.addInstallment')}
          </DialogTitle>
        </DialogHeader>
        <form {...formProps} onSubmit={handleSubmit} className="space-y-3">
          <fieldset {...fieldsetProps} className="contents">
            <div>
              <Label htmlFor="inst-description" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-addinstallmentdialog.description')}
              </Label>
              <Input
                id="inst-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t(
                  'components-credit-cards-detail-dialogs-addinstallmentdialog.eGAmazonPurchase',
                )}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="inst-amount" className="text-xs text-muted-foreground">
                  {t('components-credit-cards-detail-dialogs-addinstallmentdialog.amountR')}
                </Label>
                <Input
                  id="inst-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0,00"
                  required
                />
              </div>
              <div>
                <Label htmlFor="inst-total" className="text-xs text-muted-foreground">
                  {t(
                    'components-credit-cards-detail-dialogs-addinstallmentdialog.totalInstallments',
                  )}
                </Label>
                <Input
                  id="inst-total"
                  type="number"
                  min="1"
                  max="72"
                  value={totalInstallments}
                  onChange={(e) => setTotalInstallments(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="inst-current" className="text-xs text-muted-foreground">
                  {t(
                    'components-credit-cards-detail-dialogs-addinstallmentdialog.currentInstallment',
                  )}
                </Label>
                <Input
                  id="inst-current"
                  type="number"
                  min="1"
                  value={currentInstallmentNumber}
                  onChange={(e) => setCurrentInstallmentNumber(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="inst-cur-month" className="text-xs text-muted-foreground">
                  {t(
                    'components-credit-cards-detail-dialogs-addinstallmentdialog.currentBillMonth',
                  )}
                </Label>
                <Input
                  id="inst-cur-month"
                  type="number"
                  min="1"
                  max="12"
                  value={currentBillingMonth}
                  onChange={(e) => setCurrentBillingMonth(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="inst-cur-year" className="text-xs text-muted-foreground">
                  {t('components-credit-cards-detail-dialogs-addinstallmentdialog.currentBillYear')}
                </Label>
                <Input
                  id="inst-cur-year"
                  type="number"
                  min="2000"
                  max="2100"
                  value={currentBillingYear}
                  onChange={(e) => setCurrentBillingYear(e.target.value)}
                  required
                />
              </div>
            </div>
            <div>
              <Label htmlFor="inst-category" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-addinstallmentdialog.categoryOptional')}
              </Label>
              <Select value={categoryId} onValueChange={(v) => setCategoryId(v ?? '')}>
                <SelectTrigger id="inst-category">
                  <SelectValue
                    placeholder={t(
                      'components-credit-cards-detail-dialogs-addinstallmentdialog.selectCategory',
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                {t('components-credit-cards-detail-dialogs-addinstallmentdialog.cancel')}
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
