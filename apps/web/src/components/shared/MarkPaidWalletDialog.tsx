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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paidFromAccountId: string;
  setPaidFromAccountId: (id: string) => void;
  checkingAccounts: { id: string; name: string }[];
  onConfirm: () => void;
  isPending: boolean;
  targetLabel?: string;
  /** Dialog title. Defaults to the loan-specific "Marcar Parcela como Paga". */
  title?: string;
  /** Wallet-picker label. Defaults to the loan-specific "Pagar de qual conta?". */
  walletLabel?: string;
  /** Confirm button label. Defaults to `common.confirm`. */
  confirmLabel?: string;
};

export function MarkPaidWalletDialog({
  open,
  onOpenChange,
  paidFromAccountId,
  setPaidFromAccountId,
  checkingAccounts,
  onConfirm,
  isPending,
  targetLabel,
  title,
  walletLabel,
  confirmLabel,
}: Props) {
  const t = useTranslations();
  const dialogTitle = title ?? t('app-dashboard-loans-id-page.markInstallmentAsPaid');
  const walletPickerLabel = walletLabel ?? t('app-dashboard-loans-id-page.account');
  const confirmText = confirmLabel ?? t('common.confirm');

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        if (!v) setPaidFromAccountId('');
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>
        <fieldset disabled={isPending} aria-busy={isPending} className="contents">
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('app-dashboard-loans-id-page.selectTheAccountThe')}
            </p>
            {targetLabel && <p className="text-sm font-medium">{targetLabel}</p>}
            <div>
              <Label htmlFor="paid-from-account" className="text-xs text-muted-foreground">
                {walletPickerLabel}
              </Label>
              {checkingAccounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('common.noWalletsAvailable')}</p>
              ) : (
                <Select
                  items={checkingAccounts.map((account) => ({
                    value: account.id,
                    label: account.name,
                  }))}
                  value={paidFromAccountId}
                  onValueChange={(v) => setPaidFromAccountId(v ?? paidFromAccountId)}
                >
                  <SelectTrigger id="paid-from-account" className="w-full">
                    <SelectValue placeholder={t('common.selectAccount')} />
                  </SelectTrigger>
                  <SelectContent>
                    {checkingAccounts.map((acc) => (
                      <SelectItem key={acc.id} value={acc.id}>
                        {acc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPaidFromAccountId('');
                onOpenChange(false);
              }}
              disabled={isPending}
            >
              {t('app-dashboard-loans-id-page.cancel')}
            </Button>
            <Button onClick={onConfirm} disabled={isPending || !paidFromAccountId}>
              {isPending ? t('common.saving') : confirmText}
            </Button>
          </DialogFooter>
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}
