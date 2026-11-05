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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onChange: (v: string) => void;
  receiptDay: number;
  onReceiptDayChange: (day: number) => void;
  isPending: boolean;
  onSubmit: (trimmed: string) => void;
  onCancel: () => void;
};

export function EditPersonDialog({
  open,
  onOpenChange,
  value,
  onChange,
  receiptDay,
  onReceiptDayChange,
  isPending,
  onSubmit,
  onCancel,
}: Props) {
  const t = useTranslations();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('app-dashboard-family-loans-id-page.editPersonalCharge')}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = value.trim();
            if (!trimmed) return;
            onSubmit(trimmed);
          }}
          className="space-y-3"
          aria-busy={isPending}
        >
          <fieldset disabled={isPending} aria-busy={isPending} className="contents">
            <div>
              <Label htmlFor="edit-person-name" className="text-xs text-muted-foreground">
                {t('app-dashboard-family-loans-id-page.name')}
              </Label>
              <Input
                id="edit-person-name"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="edit-person-receipt-day" className="text-xs text-muted-foreground">
                {t('familyLoans.receiptDayLabel')}
              </Label>
              <Input
                id="edit-person-receipt-day"
                type="number"
                min={1}
                max={31}
                value={receiptDay}
                onChange={(e) => onReceiptDayChange(Number(e.target.value))}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" type="button" onClick={onCancel} disabled={isPending}>
                {t('app-dashboard-family-loans-id-page.cancel')}
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? t('common.saving') : t('common.save')}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
