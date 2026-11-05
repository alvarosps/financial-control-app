'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormDialog } from '@/components/shared/FormDialog';
import { MoneyField } from '@/components/shared/MoneyField';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { invalidateCreditCardContext } from '@/lib/invalidate';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AddCreditCardDialog({ open, onOpenChange }: Props) {
  const t = useTranslations();
  const [name, setName] = useState('');
  const [closingDay, setClosingDay] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [creditLimit, setCreditLimit] = useState('');

  const utils = trpc.useUtils();
  const createAccount = trpc.account.create.useMutation();
  const upsertConfig = trpc.creditCard.upsertConfig.useMutation();
  const isPending = createAccount.isPending || upsertConfig.isPending;

  function resetForm() {
    setName('');
    setClosingDay('');
    setDueDay('');
    setCreditLimit('');
  }

  async function handleSubmit() {
    if (!name.trim() || !closingDay || !dueDay) return;

    try {
      // 1. Create the account
      const account = await createAccount.mutateAsync({
        name: name.trim(),
        type: 'credit_card',
        currency: 'BRL',
      });

      // 2. Format credit limit
      let limitFormatted: string | null = null;
      if (creditLimit) {
        limitFormatted = toMoneyInputString(creditLimit);
      }

      // 3. Upsert Config
      await upsertConfig.mutateAsync({
        accountId: account.id,
        closingDay: parseInt(closingDay, 10),
        dueDay: parseInt(dueDay, 10),
        ...(limitFormatted && { creditLimit: limitFormatted }),
      });

      toast.success(t('components-credit-cards-addcreditcarddialog.creditCardCreatedSuccessfully'));
      await invalidateCreditCardContext(utils);
      resetForm();
      onOpenChange(false);
    } catch (error) {
      toast.error(resolveTRPCError(error, t));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        if (!v) resetForm();
        onOpenChange(v);
      }}
      title={t('components-credit-cards-addcreditcarddialog.newCreditCard')}
      onSubmit={handleSubmit}
      isPending={isPending}
      submitLabel={t('common.add')}
    >
      <div className="space-y-2">
        <Label htmlFor="cc-name">{t('components-credit-cards-addcreditcarddialog.cardName')}</Label>
        <Input
          id="cc-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('components-credit-cards-addcreditcarddialog.namePlaceholder')}
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="cc-closing">
            {t('components-credit-cards-addcreditcarddialog.closingDayLabel')}
          </Label>
          <Input
            id="cc-closing"
            type="number"
            min="1"
            max="31"
            value={closingDay}
            onChange={(e) => setClosingDay(e.target.value)}
            placeholder={t('components-credit-cards-addcreditcarddialog.closingDayPlaceholder')}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cc-due">
            {t('components-credit-cards-addcreditcarddialog.dueDayLabel')}
          </Label>
          <Input
            id="cc-due"
            type="number"
            min="1"
            max="31"
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value)}
            placeholder={t('components-credit-cards-addcreditcarddialog.dueDayPlaceholder')}
            required
          />
        </div>
      </div>

      <MoneyField
        id="cc-limit"
        label={t('components-credit-cards-addcreditcarddialog.limitLabel')}
        value={creditLimit}
        onChange={setCreditLimit}
        min="0"
      />
    </FormDialog>
  );
}
