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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { toMoneyInputString } from '@/lib/money';
import { invalidateDashboard, trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  configId: string;
  onSuccess: () => void;
};

function todayInputValue() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function RecordPaymentDialog({ open, onOpenChange, configId, onSuccess }: Props) {
  const t = useTranslations();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayInputValue());
  const [walletAccountId, setWalletAccountId] = useState('');
  const [notes, setNotes] = useState('');

  const utils = trpc.useUtils();
  const accountsQuery = trpc.account.list.useQuery();
  const wallets = (Array.isArray(accountsQuery.data) ? accountsQuery.data : []).filter(
    (a) => a.type === 'checking' && a.currency === 'BRL' && a.isActive,
  );

  const resetForm = () => {
    setAmount('');
    setDate(todayInputValue());
    setWalletAccountId('');
    setNotes('');
  };

  // Default the wallet picker to the user's default wallet once accounts load.
  useEffect(() => {
    if (walletAccountId) return;
    const preferred = wallets.find((a) => a.isDefaultWallet) ?? wallets[0];
    if (preferred) setWalletAccountId(preferred.id);
  }, [wallets, walletAccountId]);

  const mutation = trpc.familyLoan.recordPayment.useMutation({
    onSuccess: () => {
      onSuccess();
      onOpenChange(false);
      resetForm();
      utils.familyLoan.getLedger.invalidate();
      utils.familyLoan.listPayments.invalidate();
      utils.familyLoan.listWithTotals.invalidate();
      utils.account.walletsOverview.invalidate();
      invalidateDashboard(utils);
    },
    onError: (error) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  });

  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard(mutation);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        if (!v) resetForm();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('components-family-loans-recordpaymentdialog.recordPayment')}
          </DialogTitle>
        </DialogHeader>
        <form
          {...formProps}
          onSubmit={(e) => {
            e.preventDefault();
            if (!walletAccountId) return;
            const amountFormatted = toMoneyInputString(amount);
            if (!amountFormatted) {
              toast.error(t('components-family-loans-recordpaymentdialog.invalidAmount'));
              return;
            }
            const [yStr, mStr, dStr] = date.split('-');
            const paymentDate = new Date(
              Date.UTC(
                Number.parseInt(yStr, 10),
                Number.parseInt(mStr, 10) - 1,
                Number.parseInt(dStr, 10),
              ),
            );

            mutation.mutate({
              configId,
              amount: amountFormatted,
              date: paymentDate,
              walletAccountId,
              ...(notes.trim() ? { notes: notes.trim() } : {}),
            });
          }}
          className="space-y-3"
        >
          <fieldset {...fieldsetProps} className="contents">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="record-amount" className="text-xs text-muted-foreground">
                  {t('components-family-loans-recordpaymentdialog.amountR')}
                </Label>
                <Input
                  id="record-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="record-date" className="text-xs text-muted-foreground">
                  {t('components-family-loans-recordpaymentdialog.date')}
                </Label>
                <Input
                  id="record-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </div>
            </div>
            <div>
              <Label htmlFor="record-wallet" className="text-xs text-muted-foreground">
                {t('components-family-loans-recordpaymentdialog.wallet')}
              </Label>
              {wallets.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('components-family-loans-recordpaymentdialog.noWalletsAvailable')}
                </p>
              ) : (
                <Select
                  value={walletAccountId}
                  onValueChange={(v) => setWalletAccountId(v ?? walletAccountId)}
                >
                  <SelectTrigger id="record-wallet" className="w-full">
                    <SelectValue
                      placeholder={t('components-family-loans-recordpaymentdialog.selectWallet')}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {wallets.map((acc) => (
                      <SelectItem key={acc.id} value={acc.id}>
                        {acc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div>
              <Label htmlFor="record-notes" className="text-xs text-muted-foreground">
                {t('components-family-loans-recordpaymentdialog.notes')}
              </Label>
              <Input
                id="record-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('components-family-loans-recordpaymentdialog.optionalComments')}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                {t('components-family-loans-recordpaymentdialog.cancel')}
              </Button>
              <Button type="submit" {...submitProps} disabled={isPending || !walletAccountId}>
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
