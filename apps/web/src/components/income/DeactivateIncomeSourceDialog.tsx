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
import { invalidateIncomeContext } from '@/lib/invalidate';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
  name: string;
};

export function DeactivateIncomeSourceDialog({ open, onOpenChange, accountId, name }: Props) {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const deactivateMutation = trpc.income.deactivate.useMutation();
  const isPending = deactivateMutation.isPending;

  async function handleConfirm() {
    if (!accountId) return;
    try {
      await deactivateMutation.mutateAsync({ accountId });
      toast.success(t('income.deactivate.title'));
      await invalidateIncomeContext(utils);
      onOpenChange(false);
    } catch (error) {
      toast.error(resolveTRPCError(error, t));
    }
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
          <DialogTitle>{t('income.deactivate.title')}</DialogTitle>
          <DialogDescription>{t('income.deactivate.message', { name })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={isPending}>
            {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            {t('income.deactivate.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
