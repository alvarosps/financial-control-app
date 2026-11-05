'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MoneyField } from '@/components/shared/MoneyField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { currentFatura } from '@/lib/billing';
import { dateInputToDate, todayLocalISO } from '@/lib/dates';
import { invalidateCreditCardContext, invalidateQuickAddContext } from '@/lib/invalidate';
import { toMoneyInputString } from '@/lib/money';
import {
  destinationToValue,
  readLastDestination,
  valueToDestination,
  writeLastDestination,
} from '@/lib/quick-add-destination';
import { trpc } from '@/lib/trpc/client';

export type QuickAddSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wallets: { id: string; name: string; isDefaultWallet: boolean }[];
  cards: { id: string; name: string }[];
  cardConfigs: { accountId: string; closingDay: number }[];
  categories: { id: string; name: string }[];
  expenseAccountId: string;
  cardExpenseAccountId: string;
};

const noCategory = 'none';

export function QuickAddSheet({
  open,
  onOpenChange,
  wallets,
  cards,
  cardConfigs,
  categories,
  expenseAccountId,
  cardExpenseAccountId,
}: QuickAddSheetProps) {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const online = useOnlineStatus();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState(noCategory);
  const [destination, setDestination] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(todayLocalISO);

  useEffect(() => {
    if (open) setPurchaseDate(todayLocalISO());
  }, [open]);

  useEffect(() => {
    if (!open || destination) return;
    const previous = readLastDestination(window.localStorage);
    if (previous?.kind === 'wallet' && wallets.some((wallet) => wallet.id === previous.walletId)) {
      setDestination(destinationToValue(previous));
      return;
    }
    if (previous?.kind === 'card' && cards.some((card) => card.id === previous.cardId)) {
      setDestination(destinationToValue(previous));
      return;
    }
    const fallback = wallets.find((wallet) => wallet.isDefaultWallet) ?? wallets[0];
    if (fallback) setDestination(destinationToValue({ kind: 'wallet', walletId: fallback.id }));
    else if (cards[0]) setDestination(destinationToValue({ kind: 'card', cardId: cards[0].id }));
  }, [cards, destination, open, wallets]);

  const undoTransaction = trpc.transaction.reverse.useMutation({
    onSuccess: async () => {
      await Promise.all([invalidateQuickAddContext(utils), invalidateCreditCardContext(utils)]);
      toast.success(t('quickAdd.undone'));
    },
    onError: (error) => toast.error(error.message || t('common.saveFailed')),
  });
  function finishSubmit() {
    const selected = valueToDestination(destination);
    if (selected) writeLastDestination(window.localStorage, selected);
    setDescription('');
    setAmount('');
    setCategoryId(noCategory);
    onOpenChange(false);
  }

  const createTransaction = trpc.transaction.create.useMutation({
    onSuccess: async (created) => {
      await invalidateQuickAddContext(utils);
      toast.success(t('quickAdd.success'), {
        action: {
          label: t('quickAdd.undo'),
          onClick: () => undoTransaction.mutate({ id: created.id }),
        },
      });
      finishSubmit();
    },
    onError: (error) => toast.error(error.message || t('common.saveFailed')),
  });
  const addCardExpense = trpc.creditCard.addOneTimeExpense.useMutation({
    onSuccess: async (result) => {
      await Promise.all([invalidateQuickAddContext(utils), invalidateCreditCardContext(utils)]);
      toast.success(t('quickAdd.success'), {
        action: {
          label: t('quickAdd.undo'),
          onClick: () => undoTransaction.mutate({ id: result.transaction.id }),
        },
      });
      finishSubmit();
    },
    onError: (error) => toast.error(error.message || t('common.saveFailed')),
  });

  const activeMutation = destination.startsWith('card:') ? addCardExpense : createTransaction;
  const { isPending, fieldsetProps, formProps, submitProps } = useMutationFormGuard(activeMutation);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!online) return;
    const parsedAmount = toMoneyInputString(amount);
    if (!parsedAmount) {
      toast.error(t('quickAdd.invalidAmount'));
      return;
    }
    if (!description.trim()) return;

    const selected = valueToDestination(destination);
    if (!selected) {
      toast.error(t('quickAdd.selectDestination'));
      return;
    }
    const category = categoryId === noCategory ? {} : { categoryId };

    if (selected.kind === 'wallet') {
      if (!expenseAccountId) {
        toast.error(t('quickAdd.noExpenseAccount'));
        return;
      }
      createTransaction.mutate({
        sourceAccountId: expenseAccountId,
        destinationAccountId: selected.walletId,
        amount: parsedAmount,
        description: description.trim(),
        date: dateInputToDate(purchaseDate),
        ...category,
      });
      return;
    }

    const cardConfig = cardConfigs.find((config) => config.accountId === selected.cardId);
    if (!cardConfig) {
      toast.error(t('quickAdd.noCardConfig'));
      return;
    }
    if (!cardExpenseAccountId) {
      toast.error(t('quickAdd.noExpenseAccount'));
      return;
    }
    const bill = currentFatura(dateInputToDate(purchaseDate), cardConfig.closingDay);
    addCardExpense.mutate({
      creditCardAccountId: selected.cardId,
      expenseAccountId: cardExpenseAccountId,
      amount: parsedAmount,
      description: description.trim(),
      billingMonth: bill.month,
      billingYear: bill.year,
      purchaseDate,
      ...category,
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!isPending) onOpenChange(next);
      }}
    >
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[90dvh] max-w-xl overflow-y-auto rounded-t-2xl pb-[max(env(safe-area-inset-bottom),1rem)]"
      >
        <SheetHeader className="pb-0">
          <SheetTitle>{t('quickAdd.title')}</SheetTitle>
        </SheetHeader>
        <form {...formProps} onSubmit={handleSubmit} className="space-y-3 px-4 pb-2">
          {!online && <p role="status">{t('purchases.offline')}</p>}
          <fieldset {...fieldsetProps} disabled={isPending || !online} className="contents">
            <MoneyField
              id="quick-add-amount"
              label={t('quickAdd.amount')}
              value={amount}
              onChange={setAmount}
              required
            />
            <div>
              <Label htmlFor="quick-add-description" className="text-xs text-muted-foreground">
                {t('quickAdd.description')}
              </Label>
              <Input
                id="quick-add-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="quick-add-date" className="text-xs text-muted-foreground">
                {t('quickAdd.purchaseDate')}
              </Label>
              <Input
                id="quick-add-date"
                type="date"
                value={purchaseDate}
                onChange={(event) => setPurchaseDate(event.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="quick-add-destination" className="text-xs text-muted-foreground">
                {t('quickAdd.destination')}
              </Label>
              <Select value={destination} onValueChange={(value) => value && setDestination(value)}>
                <SelectTrigger id="quick-add-destination">
                  <SelectValue placeholder={t('quickAdd.selectDestination')} />
                </SelectTrigger>
                <SelectContent>
                  {wallets.map((wallet) => (
                    <SelectItem
                      key={wallet.id}
                      value={destinationToValue({ kind: 'wallet', walletId: wallet.id })}
                    >
                      {t('quickAdd.walletPrefix')} · {wallet.name}
                    </SelectItem>
                  ))}
                  {cards.map((card) => (
                    <SelectItem
                      key={card.id}
                      value={destinationToValue({ kind: 'card', cardId: card.id })}
                    >
                      {t('quickAdd.cardPrefix')} · {card.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="quick-add-category" className="text-xs text-muted-foreground">
                {t('quickAdd.category')}
              </Label>
              <Select
                value={categoryId}
                onValueChange={(value) => setCategoryId(value ?? noCategory)}
              >
                <SelectTrigger id="quick-add-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={noCategory}>{t('quickAdd.noCategory')}</SelectItem>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" className="w-full" {...submitProps}>
              {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
              {isPending ? t('common.saving') : t('quickAdd.submit')}
            </Button>
          </fieldset>
        </form>
      </SheetContent>
    </Sheet>
  );
}
