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
import { invalidateCreditCardContext } from '@/lib/invalidate';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: string | null;
  categories: { id: string; name: string }[];
  // For installments: the CURRENT bill row's parcela + amount (the schedule itself
  // always has starting_occurrence=1), plus the bill period being viewed — so an
  // edit recomputes firstBilling from the right reference point.
  currentInstallment?: number | null;
  currentAmount?: string | null;
  billMonth: number;
  billYear: number;
};

export function EditItemDialog({
  open,
  onOpenChange,
  itemId,
  categories,
  currentInstallment,
  currentAmount,
  billMonth,
  billYear,
}: Props) {
  const t = useTranslations();
  const { data: item } = trpc.scheduled.getById.useQuery(
    { id: itemId ?? '' },
    { enabled: !!itemId },
  );

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [notes, setNotes] = useState('');
  const [startingOccurrence, setStartingOccurrence] = useState('');
  const [totalOccurrences, setTotalOccurrences] = useState('');

  const isInstallment = item?.domainType === 'credit_card_installment';

  useEffect(() => {
    if (item) {
      const inst = item.domainType === 'credit_card_installment';
      setDescription(item.description);
      // For installments the schedule always carries starting_occurrence=1 and the
      // first-installment amount; the row the user clicked (current parcela + its
      // amount) is the correct edit reference, so prefer it when provided.
      const rawAmount = inst && currentAmount != null ? currentAmount : String(item.amount);
      const parsed = parseFloat(rawAmount);
      setAmount(Number.isNaN(parsed) ? '' : String(parsed));
      setCategoryId(item.categoryId ?? '');
      setNotes(item.notes ?? '');
      setStartingOccurrence(
        String(
          inst && currentInstallment != null ? currentInstallment : (item.startingOccurrence ?? 1),
        ),
      );
      setTotalOccurrences(item.totalOccurrences ? String(item.totalOccurrences) : '');
    }
  }, [item, currentAmount, currentInstallment]);

  const utils = trpc.useUtils();
  const update = trpc.scheduled.update.useMutation({
    onSuccess: async () => {
      await invalidateCreditCardContext(utils);
      resetForm();
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      toast.error(resolveTRPCError(error, t));
    },
  });

  const editInstallment = trpc.creditCard.editInstallment.useMutation({
    onSuccess: async () => {
      await invalidateCreditCardContext(utils);
      resetForm();
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      toast.error(resolveTRPCError(error, t));
    },
  });

  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard({
    isPending: update.isPending || editInstallment.isPending,
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!itemId || !description.trim()) return;

    const parsedAmount = amount ? toMoneyInputString(amount) : null;
    if (amount && !parsedAmount) {
      toast.error(t('components-credit-cards-detail-dialogs-edititemdialog.invalidAmount'));
      return;
    }

    const parsedStarting = parseInt(startingOccurrence, 10);
    const parsedTotal = parseInt(totalOccurrences, 10);

    // Installments are recurring schedules: editing the parcela/total/amount must
    // recompute the whole series (firstBilling, materialized rows, paid history)
    // from the CURRENT bill period — scheduled.update can't do that.
    if (isInstallment) {
      if (
        !parsedAmount ||
        Number.isNaN(parsedStarting) ||
        Number.isNaN(parsedTotal) ||
        parsedStarting > parsedTotal
      ) {
        toast.error(t('components-credit-cards-detail-dialogs-edititemdialog.invalidAmount'));
        return;
      }
      editInstallment.mutate({
        scheduleId: itemId,
        description: description.trim(),
        amount: parsedAmount,
        totalInstallments: parsedTotal,
        currentInstallmentNumber: parsedStarting,
        currentBillingMonth: billMonth,
        currentBillingYear: billYear,
        categoryId: categoryId || null,
      });
      return;
    }

    update.mutate({
      id: itemId,
      description: description.trim(),
      ...(parsedAmount && { amount: parsedAmount }),
      categoryId: categoryId || null,
      notes: notes.trim() || undefined,
    });
  }

  function resetForm() {
    setDescription('');
    setAmount('');
    setCategoryId('');
    setNotes('');
    setStartingOccurrence('');
    setTotalOccurrences('');
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
            {t('components-credit-cards-detail-dialogs-edititemdialog.editItem')}
          </DialogTitle>
        </DialogHeader>
        <form {...formProps} onSubmit={handleSubmit} className="space-y-3">
          <fieldset {...fieldsetProps} className="contents">
            <div>
              <Label htmlFor="edit-description" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-edititemdialog.description')}
              </Label>
              <Input
                id="edit-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="edit-amount" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-edititemdialog.amountR')}
              </Label>
              <Input
                id="edit-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            {isInstallment && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="edit-starting" className="text-xs text-muted-foreground">
                    {t('components-credit-cards-detail-dialogs-edititemdialog.currentInstallment')}
                  </Label>
                  <Input
                    id="edit-starting"
                    type="number"
                    min="1"
                    value={startingOccurrence}
                    onChange={(e) => setStartingOccurrence(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="edit-total" className="text-xs text-muted-foreground">
                    {t('components-credit-cards-detail-dialogs-edititemdialog.totalInstallments')}
                  </Label>
                  <Input
                    id="edit-total"
                    type="number"
                    min="1"
                    max="72"
                    value={totalOccurrences}
                    onChange={(e) => setTotalOccurrences(e.target.value)}
                  />
                </div>
              </div>
            )}
            <div>
              <Label htmlFor="edit-category" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-edititemdialog.category')}
              </Label>
              <Select value={categoryId} onValueChange={(v) => setCategoryId(v ?? '')}>
                <SelectTrigger id="edit-category">
                  <SelectValue
                    placeholder={t(
                      'components-credit-cards-detail-dialogs-edititemdialog.noCategory',
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
            <div>
              <Label htmlFor="edit-notes" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-edititemdialog.notes')}
              </Label>
              <Input
                id="edit-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t(
                  'components-credit-cards-detail-dialogs-edititemdialog.optionalComments',
                )}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                {t('components-credit-cards-detail-dialogs-edititemdialog.cancel')}
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
