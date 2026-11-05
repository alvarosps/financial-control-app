'use client';

import type { FinancialObligation } from '@fc/shared';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { invalidateFinancialPosition } from '@/lib/invalidate';
import { toSignedMoney } from '@/lib/money-sign';
import { trpc } from '@/lib/trpc/client';

export function FinancialObligationAction({
  item: currentItem,
  disabled = false,
}: {
  item: FinancialObligation;
  disabled?: boolean;
}) {
  const t = useTranslations('financial');
  const utils = trpc.useUtils();
  const [reviewed, setReviewed] = useState<FinancialObligation | null>(null);
  const item = reviewed ?? currentItem;
  const stale = !!reviewed && reviewed.revision !== currentItem.revision;
  const [open, setOpen] = useState(false);
  const [wallet, setWallet] = useState('');
  const [at, setAt] = useState('');
  const [amount, setAmount] = useState(item.remaining);
  const preview = trpc.account.balanceAdjustmentPreview.useQuery(
    { id: wallet },
    { enabled: open && !!wallet },
  );
  const effectiveAt = at ? new Date(`${at.length === 16 ? `${at}:00` : at}-03:00`) : null;
  const historical = !!(
    effectiveAt &&
    preview.data?.anchorAt &&
    effectiveAt.getTime() <= new Date(preview.data.anchorAt).getTime()
  );
  const wallets = trpc.account.walletsOverview.useQuery(undefined, { enabled: open });
  const success = async () => {
    await invalidateFinancialPosition(utils);
    setOpen(false);
    toast.success(t('paymentSuccess'));
  };
  const error = (err: { message: string }) => toast.error(err.message);
  const card = trpc.creditCard.payBill.useMutation({ onSuccess: success, onError: error });
  const charge = trpc.charges.markOccurrenceAsPaid.useMutation({
    onSuccess: success,
    onError: error,
  });
  const loan = trpc.loan.markOccurrenceAsPaid.useMutation({ onSuccess: success, onError: error });
  const income = trpc.income.markOccurrenceAsReceived.useMutation({
    onSuccess: success,
    onError: error,
  });
  const busy = card.isPending || charge.isPending || loan.isPending || income.isPending;
  const supported =
    ['record_payment', 'record_receipt'].includes(item.action) &&
    item.ref.kind !== 'family_receivable' &&
    item.ref.kind !== 'other';
  if (!supported)
    return (
      <Link className={buttonVariants({ variant: 'outline', size: 'sm' })} href={item.detailHref}>
        {t(
          item.action === 'review'
            ? 'review'
            : item.action === 'open_payroll'
              ? 'open_payroll'
              : item.action === 'record_receipt'
                ? 'record_receipt'
                : 'view_details',
        )}
      </Link>
    );
  const submit = () => {
    if (busy || !wallet || !at || stale || historical || !preview.data) return;
    const settlementDate = effectiveAt ?? new Date(Number.NaN);
    if (!Number.isFinite(settlementDate.getTime())) return;
    const ref = item.ref;
    if (ref.kind === 'card_bill')
      card.mutate({
        cardAccountId: ref.parentAccountId,
        month: ref.billingMonth,
        year: ref.billingYear,
        paidFromAccountId: wallet,
        settlementDate,
        expectedAmount: item.remaining,
      });
    if (ref.kind === 'charge')
      charge.mutate({
        transactionId: ref.transactionId,
        paidFromAccountId: wallet,
        settlementDate,
        expectedRevision: item.revision,
      });
    if (ref.kind === 'loan_installment')
      loan.mutate({
        accountId: ref.loanAccountId,
        transactionId: ref.transactionId,
        paidFromAccountId: wallet,
        settlementDate,
        expectedRevision: item.revision,
      });
    if (ref.kind === 'income') {
      const value = toSignedMoney(amount);
      if (!value || value.startsWith('-')) return;
      income.mutate({
        transactionId: ref.transactionId,
        paidToAccountId: wallet,
        amountBrl: value,
        settlementDate,
        expectedRevision: item.revision,
      });
    }
  };
  return (
    <>
      <Button
        variant="outline"
        className="min-h-11"
        disabled={disabled}
        onClick={() => {
          setReviewed(currentItem);
          setAmount(currentItem.remaining);
          setWallet('');
          setAt('');
          setOpen(true);
        }}
      >
        {t(item.action === 'record_receipt' ? 'record_receipt' : 'record_payment')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{item.name}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="space-y-4"
          >
            <fieldset disabled={busy || stale} className="space-y-4" aria-busy={busy}>
              <p className="text-sm text-muted-foreground">{t('recordHelp')}</p>
              <p className="text-sm text-warning">{t('anchorWarning')}</p>
              {stale && <p role="alert">{t('stale')}</p>}
              {historical && (
                <p role="alert">
                  {t('historicalBlocked')}{' '}
                  <Link className="underline" href="/transactions?filter=review">
                    {t('review')}
                  </Link>
                </p>
              )}
              {wallets.error && <p role="alert">{wallets.error.message}</p>}
              {wallets.data?.wallets.length === 0 && <p role="status">{t('noWallet')}</p>}
              {preview.error && <p role="alert">{preview.error.message}</p>}
              <Label htmlFor={`wallet-${item.key}`}>{t('wallet')}</Label>
              <Select
                value={wallet}
                onValueChange={(v) => setWallet(v ?? '')}
                items={(wallets.data?.wallets ?? []).map((w) => ({ value: w.id, label: w.name }))}
              >
                <SelectTrigger id={`wallet-${item.key}`}>
                  <SelectValue placeholder={t('wallet')} />
                </SelectTrigger>
                <SelectContent>
                  {wallets.data?.wallets.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Label htmlFor={`at-${item.key}`}>{t('paymentAt')}</Label>
              <Input
                id={`at-${item.key}`}
                type="datetime-local"
                required
                value={at}
                onChange={(e) => setAt(e.target.value)}
              />
              <Label htmlFor={`amount-${item.key}`}>{t('amount')}</Label>
              <Input
                id={`amount-${item.key}`}
                value={amount}
                readOnly={item.ref.kind !== 'income'}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
              />
              <Button
                type="submit"
                disabled={
                  busy || !wallet || !at || disabled || stale || historical || !preview.data
                }
              >
                {t(item.action === 'record_receipt' ? 'record_receipt' : 'record_payment')}
              </Button>
            </fieldset>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
