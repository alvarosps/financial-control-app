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
  itemName: string;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
};

export function DeleteItemDialog({
  open,
  onOpenChange,
  itemName,
  onConfirm,
  onCancel,
  isPending,
}: Props) {
  const t = useTranslations();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('app-dashboard-family-loans-id-page.removeItem')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('app-dashboard-family-loans-id-page.confirmDeleteItemPrefix')}{' '}
            <strong>{itemName}</strong>
            {t('app-dashboard-family-loans-id-page.confirmDeleteItemSuffix')}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={onCancel}>
              {t('app-dashboard-family-loans-id-page.cancel')}
            </Button>
            <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
              {isPending ? t('common.removing') : t('common.remove')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
