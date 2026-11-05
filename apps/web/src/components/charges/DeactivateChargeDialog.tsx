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
import { invalidateChargeContext } from '@/lib/invalidate';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scheduleId: string | null;
  name: string;
};

export function DeactivateChargeDialog({ open, onOpenChange, scheduleId, name }: Props) {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const deactivateMutation = trpc.charges.deactivate.useMutation();
  const isPending = deactivateMutation.isPending;

  async function handleConfirm() {
    if (!scheduleId) return;
    try {
      await deactivateMutation.mutateAsync({ scheduleId });
      toast.success(t('charges.deactivate.title'));
      await invalidateChargeContext(utils);
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
          <DialogTitle>{t('charges.deactivate.title')}</DialogTitle>
          <DialogDescription>{t('charges.deactivate.message', { name })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={isPending}>
            {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            {t('charges.deactivate.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
