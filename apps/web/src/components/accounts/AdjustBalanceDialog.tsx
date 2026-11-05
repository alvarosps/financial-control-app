'use client';

import { Money } from '@fc/domain';
import { Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
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
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { formatCurrency } from '@/lib/format';
import { invalidateFinancialPosition } from '@/lib/invalidate';
import { toSignedMoney } from '@/lib/money-sign';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  walletId: string;
  currentCash: number;
};

export function AdjustBalanceDialog({ open, onOpenChange, walletId, currentCash }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const reviewedRevision = useRef<string | null>(null);
  const initialCash = useRef(currentCash);
  initialCash.current = currentCash;
  const [cash, setCash] = useState('');
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const preview = trpc.account.balanceAdjustmentPreview.useQuery(
    { id: walletId },
    { enabled: open && !!walletId, refetchOnWindowFocus: false, staleTime: 0 },
  );

  useEffect(() => {
    reviewedRevision.current = null;
    if (open && walletId) {
      setCash(initialCash.current.toFixed(2));
      setReason('');
      setInvalid(false);
    }
  }, [open, walletId]);
  useEffect(() => {
    if (open && preview.data && !preview.isFetching && !reviewedRevision.current)
      reviewedRevision.current = preview.data.revision;
  }, [open, preview.data, preview.isFetching]);

  const utils = trpc.useUtils();
  const parsedCash = toSignedMoney(cash);
  const difference =
    parsedCash && preview.data
      ? Money.fromString(parsedCash, 'BRL')
          .subtract(Money.fromNumber(preview.data.cash, 'BRL'))
          .toNumber()
      : null;
  const reanchor = trpc.account.reanchorWallet.useMutation({
    onSuccess: async () => {
      await invalidateFinancialPosition(utils);
      toast.success(t('wallets.adjust.success'));
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message || t('wallets.adjust.error')),
  });

  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard(reanchor);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const formatted = toSignedMoney(cash);
    if (!formatted) {
      setInvalid(true);
      return;
    }
    if (
      !preview.data ||
      preview.isFetching ||
      !reviewedRevision.current ||
      reason.trim().length < 3
    )
      return;

    reanchor.mutate({
      id: walletId,
      cash: formatted,
      reason: reason.trim(),
      expectedRevision: reviewedRevision.current,
    });
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
          <DialogTitle>{t('wallets.adjust.title')}</DialogTitle>
        </DialogHeader>
        <form {...formProps} onSubmit={handleSubmit} className="space-y-4">
          <fieldset {...fieldsetProps} className="contents">
            {preview.data && (
              <p className="text-sm">
                {preview.data.name} · {formatCurrency(preview.data.cash)}
              </p>
            )}
            {preview.error && <p role="alert">{preview.error.message}</p>}
            <p className="text-xs text-muted-foreground">{t('financial.balanceObservation')}</p>
            {preview.data?.anchorAt && (
              <p className="text-xs text-muted-foreground">
                {t('financial.balanceReference', {
                  date: new Date(preview.data.anchorAt).toLocaleString(locale, {
                    timeZone: 'America/Sao_Paulo',
                  }),
                })}
              </p>
            )}
            {difference !== null && (
              <p>{t('financial.balanceDifference', { amount: formatCurrency(difference) })}</p>
            )}
            <div className="space-y-2">
              <Label htmlFor="wallet-cash">{t('wallets.adjust.field')}</Label>
              <Input
                id="wallet-cash"
                inputMode="decimal"
                value={cash}
                onChange={(e) => setCash(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">{t('wallets.adjust.help')}</p>
              {invalid && (
                <p role="alert" className="text-sm text-expense">
                  {t('financial.invalidBalance')}
                </p>
              )}
              <Label htmlFor="balance-reason">{t('financial.reason')}</Label>
              <Input
                id="balance-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={3}
                maxLength={500}
                required
              />
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                {...submitProps}
                disabled={
                  isPending || preview.isFetching || !preview.data || reason.trim().length < 3
                }
              >
                {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                {isPending ? t('common.saving') : t('wallets.adjust.action')}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
