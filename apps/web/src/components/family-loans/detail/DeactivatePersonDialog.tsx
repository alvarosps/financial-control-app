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
  onCancel: () => void;
  isPending: boolean;
};

export function DeactivatePersonDialog({
  open,
  onOpenChange,
  accountName,
  onConfirm,
  onCancel,
  isPending,
}: Props) {
  const t = useTranslations();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('app-dashboard-family-loans-id-page.deactivatePersonalCharge')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('app-dashboard-family-loans-id-page.confirmDeactivatePersonPrefix')}{' '}
            <strong>{accountName}</strong>
            {t('app-dashboard-family-loans-id-page.confirmDeactivatePersonSuffix')}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={onCancel}>
              {t('app-dashboard-family-loans-id-page.cancel')}
            </Button>
            <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
              {isPending
                ? t('app-dashboard-family-loans-id-page.deactivating')
                : t('app-dashboard-family-loans-id-page.deactivate')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
