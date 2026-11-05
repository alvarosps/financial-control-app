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
  amountLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
};

export function ReversePaymentDialog({
  open,
  onOpenChange,
  amountLabel,
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
            {t('components-family-loans-detail-reversepaymentdialog.title')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('components-family-loans-detail-reversepaymentdialog.confirmPrefix')}{' '}
            <strong>{amountLabel}</strong>
            {t('components-family-loans-detail-reversepaymentdialog.confirmSuffix')}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
              {isPending
                ? t('components-family-loans-detail-reversepaymentdialog.reversing')
                : t('components-family-loans-detail-reversepaymentdialog.reverse')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
