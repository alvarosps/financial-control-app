'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FormDialog } from '@/components/shared/FormDialog';
import { MoneyField } from '@/components/shared/MoneyField';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: {
    id: string;
    name: string;
    type: string;
    overdraftLimit?: string | null;
    cdiPercentage?: string | null;
  } | null;
};

export function EditAccountDialog({ open, onOpenChange, account }: Props) {
  const t = useTranslations();
  const [name, setName] = useState('');
  const [cdiPercentage, setCdiPercentage] = useState('');
  const [overdraftLimit, setOverdraftLimit] = useState('');

  useEffect(() => {
    if (open && account) {
      setName(account.name);
      setCdiPercentage(account.cdiPercentage ?? '');
      setOverdraftLimit(account.overdraftLimit ?? '');
    }
  }, [open, account]);

  const utils = trpc.useUtils();
  const updateAccount = trpc.account.update.useMutation({
    onSuccess: () => {
      utils.account.list.invalidate();
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  });
  const isPending = updateAccount.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!account || !name.trim()) return;

    const cdiFormatted = cdiPercentage ? toMoneyInputString(cdiPercentage) : null;
    const overdraftFormatted = overdraftLimit ? toMoneyInputString(overdraftLimit) : null;

    updateAccount.mutate({
      id: account.id,
      name: name.trim(),
      ...(cdiFormatted && { cdiPercentage: cdiFormatted }),
      ...(overdraftFormatted && { overdraftLimit: overdraftFormatted }),
    });
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(value) => {
        if (isPending) return;
        onOpenChange(value);
      }}
      title={t('components-accounts-editaccountdialog.editAccount')}
      onSubmit={handleSubmit}
      isPending={isPending}
    >
      <div className="space-y-2">
        <Label htmlFor="edit-acc-name">
          {t('components-accounts-editaccountdialog.accountName')}
        </Label>
        <Input id="edit-acc-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>

      {account?.type === 'checking' && (
        <MoneyField
          id="edit-acc-overdraft"
          label={t('components-accounts-editaccountdialog.overdraftLabel')}
          value={overdraftLimit}
          onChange={setOverdraftLimit}
          min="0"
        />
      )}

      {account?.type === 'investment' && (
        <div className="space-y-2">
          <Label htmlFor="edit-acc-cdi">
            {t('components-accounts-editaccountdialog.cdiLabel')}
          </Label>
          <Input
            id="edit-acc-cdi"
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
