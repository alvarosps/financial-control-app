'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: { id: string; name: string } | null;
};

export function DeactivateAccountDialog({ open, onOpenChange, account }: Props) {
  const t = useTranslations();
  const utils = trpc.useUtils();

  const deactivateAccount = trpc.account.deactivate.useMutation({
    onMutate: async (vars) => {
      await utils.account.list.cancel();
      const prev = utils.account.list.getData();
      utils.account.list.setData(undefined, (old) =>
        Array.isArray(old) ? old.filter((a) => a.id !== vars.id) : old,
      );
      return { prev };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.prev) utils.account.list.setData(undefined, ctx.prev);
      toast.error(
        error.message || t('components-accounts-deactivateaccountdialog.deactivateError'),
      );
    },
    onSuccess: () => {
      toast.success(
        t('components-accounts-deactivateaccountdialog.accountDeactivatedSuccessfully'),
      );
      onOpenChange(false);
    },
    onSettled: () => {
      utils.account.list.invalidate();
    },
  });

  const { isPending, submitProps } = useMutationFormGuard(deactivateAccount);

  function handleConfirm() {
    if (!account) return;
    deactivateAccount.mutate({ id: account.id });
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
            {t('components-accounts-deactivateaccountdialog.deactivateAccount')}
          </DialogTitle>
          <DialogDescription>
            {t('components-accounts-deactivateaccountdialog.confirmDescription', {
              name: account?.name ?? '',
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t('components-accounts-deactivateaccountdialog.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} {...submitProps}>
            {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            {isPending
              ? t('components-accounts-deactivateaccountdialog.deactivating')
              : t('components-accounts-deactivateaccountdialog.deactivate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
