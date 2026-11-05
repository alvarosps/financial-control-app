'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountName: string;
  onConfirm: () => void;
  isPending: boolean;
};

export function DeactivateLoanDialog({
  open,
  onOpenChange,
  accountName,
  onConfirm,
  isPending,
}: Props) {
  const t = useTranslations();

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onOpenChange(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('app-dashboard-loans-id-page.deactivateLoan')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t('app-dashboard-loans-id-page.doYouWantTo')} <strong>{accountName}</strong>
          {t('app-dashboard-loans-id-page.thisActionWillAlso')}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('app-dashboard-loans-id-page.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
            {isPending
              ? t('components-loans-detail-deactivateloandialog.deactivating')
              : t('components-loans-detail-deactivateloandialog.deactivate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
