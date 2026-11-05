'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormDialog } from '@/components/shared/FormDialog';
import { MoneyField } from '@/components/shared/MoneyField';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AddAccountDialog({ open, onOpenChange }: Props) {
  const t = useTranslations();
  const [name, setName] = useState('');
  const [type, setType] = useState<'checking' | 'savings' | 'investment'>('checking');
  const [currency, setCurrency] = useState('BRL');
  const [cdiPercentage, setCdiPercentage] = useState('');
  const [overdraftLimit, setOverdraftLimit] = useState('');

  const utils = trpc.useUtils();
  const createAccount = trpc.account.create.useMutation({
    onSuccess: () => {
      utils.account.list.invalidate();
      resetForm();
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  });
  const isPending = createAccount.isPending;

  function resetForm() {
    setName('');
    setType('checking');
    setCurrency('BRL');
    setCdiPercentage('');
    setOverdraftLimit('');
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    const cdiFormatted = cdiPercentage ? toMoneyInputString(cdiPercentage) : null;
    const overdraftFormatted = overdraftLimit ? toMoneyInputString(overdraftLimit) : null;

    createAccount.mutate({
      name: name.trim(),
      type,
      currency,
      ...(cdiFormatted && { cdiPercentage: cdiFormatted }),
      ...(overdraftFormatted && { overdraftLimit: overdraftFormatted }),
    });
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(value) => {
        if (isPending) return;
        if (!value) resetForm();
        onOpenChange(value);
      }}
      title={t('components-accounts-addaccountdialog.newAccount')}
      onSubmit={handleSubmit}
      isPending={isPending}
      submitLabel={t('common.add')}
    >
      <div className="space-y-2">
        <Label htmlFor="acc-name">{t('components-accounts-addaccountdialog.accountName')}</Label>
        <Input
          id="acc-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('components-accounts-addaccountdialog.eGNubankItau')}
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="acc-type">{t('components-accounts-addaccountdialog.typeLabel')}</Label>
          <Select
            value={type}
            onValueChange={(value) => setType(value as 'checking' | 'savings' | 'investment')}
          >
            <SelectTrigger id="acc-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="checking">
                {t('components-accounts-addaccountdialog.typeChecking')}
              </SelectItem>
              <SelectItem value="savings">
                {t('components-accounts-addaccountdialog.savings')}
              </SelectItem>
              <SelectItem value="investment">
                {t('components-accounts-addaccountdialog.typeInvestment')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="acc-currency">
            {t('components-accounts-addaccountdialog.currencyLabel')}
          </Label>
          <Select value={currency} onValueChange={(value) => setCurrency(value ?? 'BRL')}>
            <SelectTrigger id="acc-currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="BRL">{t('currencies.brl')}</SelectItem>
              <SelectItem value="USD">{t('currencies.usd')}</SelectItem>
              <SelectItem value="EUR">{t('currencies.eur')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {type === 'checking' && (
        <MoneyField
          id="acc-overdraft"
          label={t('components-accounts-addaccountdialog.overdraftLabel')}
          value={overdraftLimit}
          onChange={setOverdraftLimit}
          min="0"
        />
      )}

      {type === 'investment' && (
        <div className="space-y-2">
          <Label htmlFor="acc-cdi">{t('components-accounts-addaccountdialog.cdiLabel')}</Label>
          <Input
            id="acc-cdi"
            type="number"
            step="0.01"
            min="0"
            value={cdiPercentage}
            onChange={(e) => setCdiPercentage(e.target.value)}
            placeholder="100"
          />
        </div>
      )}
    </FormDialog>
  );
}
