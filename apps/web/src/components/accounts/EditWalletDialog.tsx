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
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { toSignedMoney } from '@/lib/money-sign';
import { trpc } from '@/lib/trpc/client';

type Wallet = {
  id: string;
  name: string;
  overdraftLimit?: string | null;
  isDefaultWallet?: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wallet: Wallet | null;
};

export function EditWalletDialog({ open, onOpenChange, wallet }: Props) {
  const t = useTranslations();
  const [name, setName] = useState('');
  const [overdraftLimit, setOverdraftLimit] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);

  useEffect(() => {
    if (open && wallet) {
      setName(wallet.name);
      setOverdraftLimit(wallet.overdraftLimit ?? '');
      setMakeDefault(Boolean(wallet.isDefaultWallet));
    }
  }, [open, wallet]);

  const utils = trpc.useUtils();
  const setDefault = trpc.account.setDefaultWallet.useMutation();
  const updateAccount = trpc.account.update.useMutation({
    onSuccess: async () => {
      try {
        if (wallet && makeDefault && !wallet.isDefaultWallet) {
          await setDefault.mutateAsync({ id: wallet.id });
        }
        await utils.account.walletsOverview.invalidate();
        onOpenChange(false);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('common.saveFailed'));
      }
    },
    onError: (error) => toast.error(error.message || t('common.saveFailed')),
  });

  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard(updateAccount);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet || !name.trim()) return;

    const overdraftFormatted = overdraftLimit ? toSignedMoney(overdraftLimit) : null;

    updateAccount.mutate({
      id: wallet.id,
      name: name.trim(),
      ...(overdraftFormatted && { overdraftLimit: overdraftFormatted.replace('-', '') }),
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
          <DialogTitle>{t('wallets.edit.title')}</DialogTitle>
        </DialogHeader>
        <form {...formProps} onSubmit={handleSubmit} className="space-y-4">
          <fieldset {...fieldsetProps} className="contents">
            <div className="space-y-2">
              <Label htmlFor="wallet-name">{t('common.name')}</Label>
              <Input
                id="wallet-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="wallet-overdraft">{t('wallets.edit.overdraftLimit')}</Label>
              <Input
                id="wallet-overdraft"
                inputMode="decimal"
                value={overdraftLimit}
                onChange={(e) => setOverdraftLimit(e.target.value)}
              />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={makeDefault}
                onChange={(e) => setMakeDefault(e.target.checked)}
              />
              {t('wallets.edit.makeDefault')}
            </label>

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
