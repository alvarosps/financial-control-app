'use client';

import { Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
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
import { currentFatura, type Fatura, faturaWindow } from '@/lib/billing';
import { dateInputToDate } from '@/lib/dates';
import { invalidateCreditCardContext } from '@/lib/invalidate';
import { getMonthName } from '@/lib/labels';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';
import { cn } from '@/lib/utils';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cardId: string;
  defaultSourceAccountId: string;
  closingDay: number;
  dueDay: number;
  categories: { id: string; name: string }[];
};

type ExpenseType = 'expense' | 'fixed';

function faturaKey(f: Fatura): string {
  return `${f.year}-${f.month}`;
}

export function AddExpenseDialog({
  open,
  onOpenChange,
  cardId,
  defaultSourceAccountId,
  closingDay,
  dueDay,
  categories,
}: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [expenseType, setExpenseType] = useState<ExpenseType>('expense');
  const defaultFatura = useMemo(() => currentFatura(new Date(), closingDay), [closingDay]);
  const [selectedFaturaKey, setSelectedFaturaKey] = useState(() => faturaKey(defaultFatura));
  const [purchaseDate, setPurchaseDate] = useState('');

  const faturaOptions = useMemo(() => faturaWindow(defaultFatura, 6, 6), [defaultFatura]);
  const selectedFatura =
    faturaOptions.find((f) => faturaKey(f) === selectedFaturaKey) ?? defaultFatura;

  const { data: billHistory } = trpc.creditCard.getBillHistory.useQuery({ cardAccountId: cardId });
  const paidKeys = useMemo(() => {
    const set = new Set<string>();
    for (const b of billHistory ?? []) {
      if (b.isPaid) set.add(`${b.year}-${b.month}`);
    }
    return set;
  }, [billHistory]);

  const utils = trpc.useUtils();
  const mutationOptions = {
    onSuccess: async () => {
      await invalidateCreditCardContext(utils);
      resetForm();
      onOpenChange(false);
    },
    onError: (error: { message: string }) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  };
  const addOneTime = trpc.creditCard.addOneTimeExpense.useMutation(mutationOptions);
  const addFixed = trpc.creditCard.addFixedCharge.useMutation(mutationOptions);

  const activeMutation = expenseType === 'fixed' ? addFixed : addOneTime;
  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard(activeMutation);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsedAmount = toMoneyInputString(amount);
    if (!description.trim() || !parsedAmount) {
      if (amount && !parsedAmount)
        toast.error(t('components-credit-cards-detail-dialogs-addexpensedialog.invalidAmount'));
      return;
    }

    const isFixed = expenseType === 'fixed';
    const common = {
      creditCardAccountId: cardId,
      expenseAccountId: defaultSourceAccountId,
      amount: parsedAmount,
      description: description.trim(),
      ...(categoryId && { categoryId }),
    };

    if (isFixed) {
      addFixed.mutate({
        ...common,
        dueDay,
        startDate: new Date(selectedFatura.year, selectedFatura.month - 1, 1),
        firstBillingMonth: selectedFatura.month,
        firstBillingYear: selectedFatura.year,
      });
    } else {
      addOneTime.mutate({
        ...common,
        billingMonth: selectedFatura.month,
        billingYear: selectedFatura.year,
        ...(purchaseDate && { purchaseDate: dateInputToDate(purchaseDate) }),
      });
    }
  }

  function resetForm() {
    setDescription('');
    setAmount('');
    setCategoryId('');
    setExpenseType('expense');
    setSelectedFaturaKey(faturaKey(defaultFatura));
    setPurchaseDate('');
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
            {t('components-credit-cards-detail-dialogs-addexpensedialog.addMonthlyExpense')}
          </DialogTitle>
        </DialogHeader>
        <form {...formProps} onSubmit={handleSubmit} className="space-y-3">
          <fieldset {...fieldsetProps} className="contents">
            {/* Type toggle */}
            <div>
              <Label className="text-xs text-muted-foreground">{t('common.type')}</Label>
              <div className="grid grid-cols-2 gap-2 mt-1">
                <button
                  type="button"
                  onClick={() => setExpenseType('expense')}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                    expenseType === 'expense'
                      ? 'border-warning bg-warning/10 text-warning'
                      : 'border-glass-border text-muted-foreground hover:border-warning/50',
                  )}
                >
                  {t('creditCards.addExpense.avulsa')}
                </button>
                <button
                  type="button"
                  onClick={() => setExpenseType('fixed')}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                    expenseType === 'fixed'
                      ? 'border-brand-fixed bg-brand-fixed/10 text-brand-fixed'
                      : 'border-glass-border text-muted-foreground hover:border-brand-fixed/50',
                  )}
                >
                  {t('creditCards.addExpense.fixa')}
                </button>
              </div>
            </div>
            <div>
              <Label htmlFor="exp-description" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-addexpensedialog.description')}
              </Label>
              <Input
                id="exp-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={
                  expenseType === 'fixed'
                    ? t('creditCards.expensePlaceholders.fixed')
                    : t('creditCards.expensePlaceholders.variable')
                }
                required
              />
            </div>
            <div>
              <Label htmlFor="exp-amount" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-addexpensedialog.amountR')}
              </Label>
              <Input
                id="exp-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="exp-fatura" className="text-xs text-muted-foreground">
                {t('creditCards.addExpense.faturaLabel')}
              </Label>
              <Select value={selectedFaturaKey} onValueChange={(v) => v && setSelectedFaturaKey(v)}>
                <SelectTrigger id="exp-fatura">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {faturaOptions.map((f) => {
                    const key = faturaKey(f);
                    const isPaid = paidKeys.has(key);
                    return (
                      <SelectItem key={key} value={key} disabled={isPaid}>
                        {getMonthName(f.month, locale)}/{f.year}
                        {isPaid ? ` — ${t('creditCards.addExpense.faturaPaidHint')}` : ''}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            {expenseType === 'expense' && (
              <div>
                <Label htmlFor="exp-purchase-date" className="text-xs text-muted-foreground">
                  {t('creditCards.addExpense.purchaseDate')}
                </Label>
                <Input
                  id="exp-purchase-date"
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                />
              </div>
            )}
            <div>
              <Label htmlFor="exp-category" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-addexpensedialog.categoryOptional')}
              </Label>
              <Select value={categoryId} onValueChange={(v) => setCategoryId(v ?? '')}>
                <SelectTrigger id="exp-category">
                  <SelectValue placeholder={t('common.selectCategory')} />
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
                {t('components-credit-cards-detail-dialogs-addexpensedialog.cancel')}
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
