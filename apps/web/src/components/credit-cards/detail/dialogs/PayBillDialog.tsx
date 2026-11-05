'use client';

import { Money } from '@fc/domain';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { formatCurrency, formatDueDate } from '@/lib/format';
import { invalidateFinancialPosition } from '@/lib/invalidate';
import { getMonthName } from '@/lib/labels';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cardId: string;
  month: number;
  year: number;
  billTotal: number;
  paymentAccounts: { id: string; name: string }[];
  cardName?: string;
  dueDate?: string | null;
  paymentAmount?: number;
  breakdown?: { cardId: string; name: string; unpaidTotal: number }[];
  isLoading?: boolean;
  loadError?: string;
  onRetry?: () => void;
  onPaymentError?: () => Promise<unknown>;
  finalFocus?: () => HTMLElement | null;
};

export function PayBillDialog({
  open,
  onOpenChange,
  cardId,
  month,
  year,
  billTotal,
  paymentAccounts,
  cardName,
  dueDate,
  paymentAmount = billTotal,
  breakdown,
  isLoading = false,
  loadError,
  onRetry,
  onPaymentError,
  finalFocus,
}: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const [paidAt, setPaidAt] = useState('');
  const [accountId, setAccountId] = useState('');
  const submitting = useRef(false);
  const preview = trpc.account.balanceAdjustmentPreview.useQuery(
    { id: accountId },
    { enabled: open && !!accountId },
  );
  const effectiveDate = paidAt
    ? new Date(`${paidAt.length === 16 ? `${paidAt}:00` : paidAt}-03:00`)
    : null;
  const historical = !!(
    effectiveDate &&
    preview.data?.anchorAt &&
    effectiveDate.getTime() <= new Date(preview.data.anchorAt).getTime()
  );
  useEffect(() => {
    if (!open) setPaidAt('');
  }, [open]);

  useEffect(() => {
    if (!paymentAccounts.some((account) => account.id === accountId)) {
      setAccountId(paymentAccounts.length === 1 ? paymentAccounts[0].id : '');
    }
  }, [paymentAccounts, accountId]);

  const selectedAccountName = paymentAccounts.find((a) => a.id === accountId)?.name;

  const utils = trpc.useUtils();
  const pay = trpc.creditCard.payBill.useMutation({
    onSuccess: async () => {
      await invalidateFinancialPosition(utils);
      setAccountId('');
      onOpenChange(false);
    },
    onError: async (error: unknown) => {
      toast.error(resolveTRPCError(error, t));
      await onPaymentError?.();
    },
    onSettled: () => {
      submitting.current = false;
    },
  });

  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard(pay);
  const canPay =
    !isLoading &&
    !loadError &&
    paymentAmount > 0 &&
    billTotal > 0 &&
    Boolean(selectedAccountName) &&
    !!effectiveDate &&
    Number.isFinite(effectiveDate.getTime()) &&
    !historical &&
    !!preview.data;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canPay || isPending || submitting.current) return;
    submitting.current = true;
    pay.mutate({
      cardAccountId: cardId,
      month,
      year,
      paidFromAccountId: accountId,
      settlementDate: effectiveDate ?? undefined,
      expectedAmount: Money.fromNumber(paymentAmount, 'BRL').toDbString(),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending || submitting.current) return;
        if (!v) setAccountId('');
        onOpenChange(v);
      }}
    >
      <DialogContent
        finalFocus={finalFocus}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        showCloseButton={!isPending}
      >
        <DialogHeader>
          <DialogTitle>
            {t('components-credit-cards-detail-dialogs-paybilldialog.payBill')}
          </DialogTitle>
          {cardName && <DialogDescription>{cardName}</DialogDescription>}
        </DialogHeader>
        {isLoading && !isPending ? (
          <p role="status" className="py-4 text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        ) : loadError && !isPending ? (
          <ErrorAlert message={loadError} onRetry={onRetry} />
        ) : paymentAccounts.length === 0 && !isPending ? (
          <>
            <p className="text-sm text-muted-foreground py-4">
              {t('components-credit-cards-detail-dialogs-paybilldialog.noAccountAvailableFor')}
            </p>
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
                {t('components-credit-cards-detail-dialogs-paybilldialog.close')}
              </Button>
            </DialogFooter>
          </>
        ) : (paymentAmount <= 0 || billTotal <= 0) && !isPending ? (
          <p role="status" className="py-4 text-sm text-muted-foreground">
            {t('creditCards.bill.nothingToPay')}
          </p>
        ) : (
          <form {...formProps} onSubmit={handleSubmit} className="space-y-3">
            {pay.error && <ErrorAlert message={resolveTRPCError(pay.error, t)} />}
            <fieldset {...fieldsetProps} className="contents">
              <div className="text-center py-2">
                <p className="text-sm text-muted-foreground">
                  {t('components-credit-cards-detail-dialogs-paybilldialog.billFrom')}{' '}
                  {getMonthName(month, locale)} {year}
                </p>
                {dueDate && (
                  <p className="text-sm text-muted-foreground">
                    {t('creditCards.payment.dueDate', { date: formatDueDate(dueDate) })}
                  </p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('creditCards.payment.amount')}
                </p>
                <AmountDisplay amount={paymentAmount} size="lg" variant="neutral" />
                {billTotal !== paymentAmount && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('creditCards.payment.billTotal', { amount: formatCurrency(billTotal) })}
                  </p>
                )}
              </div>
              {breakdown && breakdown.length > 1 && (
                <dl
                  className="space-y-1 rounded-lg border p-3 text-sm"
                  aria-label={t('creditCards.payment.breakdown')}
                >
                  {breakdown.map((card) => (
                    <div key={card.cardId} className="flex justify-between gap-3">
                      <dt>{card.name}</dt>
                      <dd className="font-numeric tabular-nums">
                        {formatCurrency(card.unpaidTotal)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <div>
                <Label htmlFor="pay-account" className="text-xs text-muted-foreground">
                  {t('components-credit-cards-detail-dialogs-paybilldialog.payFromAccount')}
                </Label>
                {paymentAccounts.length === 1 ? (
                  <div className="flex items-center h-9 rounded-md border border-input bg-transparent px-3 text-sm">
                    {paymentAccounts[0].name}
                  </div>
                ) : (
                  <Select value={accountId} onValueChange={(v) => setAccountId(v ?? '')}>
                    <SelectTrigger id="pay-account">
                      <SelectValue placeholder={t('common.selectAccount')}>
                        {selectedAccountName ?? t('common.selectAccount')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {paymentAccounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('financial.recordHelp')}</p>
              <Label htmlFor="bill-payment-at">{t('financial.paymentAt')}</Label>
              <Input
                id="bill-payment-at"
                type="datetime-local"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
                required
              />
              {historical && (
                <p role="alert">
                  {t('financial.historicalBlocked')}{' '}
                  <Link className="underline" href="/transactions?filter=review">
                    {t('financial.review')}
                  </Link>
                </p>
              )}
              {preview.error && <ErrorAlert message={preview.error.message} />}
              <DialogFooter>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => onOpenChange(false)}
                  disabled={isPending}
                >
                  {t('components-credit-cards-detail-dialogs-paybilldialog.cancel')}
                </Button>
                <Button type="submit" {...submitProps} disabled={submitProps.disabled || !canPay}>
                  {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                  {isPending ? t('common.paying') : t('common.confirm')}
                </Button>
              </DialogFooter>
            </fieldset>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
