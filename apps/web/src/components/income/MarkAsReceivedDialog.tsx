'use client';

import { Money } from '@fc/domain';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
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
import { formatCurrency } from '@/lib/format';
import { invalidateDashboard, trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  walletId: string;
  setWalletId: (id: string) => void;
  wallets: { id: string; name: string }[];
  /** Occurrence label ("Inscyth — 05/06/2026"). */
  occurrenceLabel: string;
  /** When the source is forex, the editable BRL string ("5180.00"); else undefined. */
  amountBrl?: string;
  setAmountBrl?: (v: string) => void;
  transactionId: string;
  grossBrl: string | null;
  onConfirm: (settlementDate: Date) => void;
  isPending: boolean;
};

export function MarkAsReceivedDialog({
  open,
  onOpenChange,
  walletId,
  setWalletId,
  wallets,
  occurrenceLabel,
  amountBrl,
  setAmountBrl,
  onConfirm,
  isPending,
  transactionId,
  grossBrl,
}: Props) {
  const t = useTranslations();
  const isForex = amountBrl !== undefined && setAmountBrl !== undefined;
  const [date, setDate] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [net, setNet] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const utils = trpc.useUtils();
  const options = trpc.income.payrollOptions.useQuery({ incomeTransactionId: transactionId });
  const payroll = trpc.income.settlePayroll.useMutation({
    onSuccess: () => {
      utils.income.invalidate();
      utils.loan.invalidate();
      utils.account.invalidate();
      utils.projection.invalidate();
      utils.simulator.invalidate();
      invalidateDashboard(utils);
      toast.success(t('income.markReceived.success'));
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });
  const busy = isPending || payroll.isPending;
  const deductions = Money.sum(
    (options.data?.candidates ?? [])
      .filter((candidate) => selected.includes(candidate.transactionId))
      .map((candidate) => Money.fromString(candidate.amount, 'BRL')),
    'BRL',
  );
  const expectedNet =
    grossBrl === null ? null : Money.fromString(grossBrl, 'BRL').subtract(deductions);
  const normalizedNet = net.trim().includes(',')
    ? net.trim().replace(/\./g, '').replace(',', '.')
    : net.trim();
  const parsedNet = /^\d+(\.\d{1,2})?$/.test(normalizedNet)
    ? Money.fromString(normalizedNet, 'BRL').toDbString()
    : null;
  const differs =
    parsedNet !== null && expectedNet !== null && parsedNet !== expectedNet.toDbString();

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        if (!v) setWalletId('');
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('income.markReceived.title')}</DialogTitle>
        </DialogHeader>
        <fieldset disabled={busy} aria-busy={busy} className="contents">
          <div className="space-y-3">
            <p className="text-sm font-medium">{occurrenceLabel}</p>
            <Label htmlFor="receive-date">{t('cashForecast.effectiveDate')}</Label>
            <Input
              id="receive-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('cashForecast.chooseOccurrence')}</p>
            <div>
              <Label htmlFor="receive-wallet" className="text-xs text-muted-foreground">
                {t('income.markReceived.walletLabel')}
              </Label>
              {wallets.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('common.noWalletsAvailable')}</p>
              ) : (
                <Select value={walletId} onValueChange={(v) => setWalletId(v ?? walletId)}>
                  <SelectTrigger id="receive-wallet" className="w-full">
                    <SelectValue placeholder={t('common.selectAccount')} />
                  </SelectTrigger>
                  <SelectContent>
                    {wallets.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {isForex && selected.length === 0 && (
              <div>
                <Label htmlFor="receive-brl" className="text-xs text-muted-foreground">
                  {t('income.markReceived.brlLabel')}
                </Label>
                <Input
                  id="receive-brl"
                  inputMode="decimal"
                  value={amountBrl}
                  onChange={(e) => setAmountBrl(e.target.value)}
                />
              </div>
            )}
            {options.error && (
              <p role="alert" className="text-expense">
                {options.error.message}
              </p>
            )}
            {(options.data?.candidates.length ?? 0) > 0 && (
              <div className="space-y-2 border-t pt-3">
                <p className="text-sm font-medium">{t('cashForecast.deductions')}</p>
                {options.data?.candidates.map((candidate) => (
                  <label key={candidate.transactionId} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(candidate.transactionId)}
                      onChange={(event) => {
                        setSelected(
                          event.target.checked
                            ? [...selected, candidate.transactionId]
                            : selected.filter((id) => id !== candidate.transactionId),
                        );
                        setAcknowledge(false);
                      }}
                    />
                    {candidate.description} · {candidate.date.toISOString().slice(0, 10)} ·{' '}
                    {formatCurrency(Number(candidate.amount))}
                  </label>
                ))}
              </div>
            )}
            {selected.length > 0 && (
              <div className="space-y-2">
                <p className="font-numeric tabular-nums text-sm">
                  {t('cashForecast.composition', {
                    gross:
                      grossBrl === null
                        ? t('cashForecast.unavailable')
                        : formatCurrency(Number(grossBrl)),
                    deductions: formatCurrency(deductions.toNumber()),
                    net:
                      expectedNet === null
                        ? t('cashForecast.unavailable')
                        : formatCurrency(expectedNet.toNumber()),
                  })}
                </p>
                <Label htmlFor="payroll-net">{t('cashForecast.reportedNet')}</Label>
                <Input
                  id="payroll-net"
                  inputMode="decimal"
                  value={net}
                  onChange={(event) => {
                    setNet(event.target.value);
                    setAcknowledge(false);
                  }}
                />
                {differs && (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={acknowledge}
                      onChange={(event) => setAcknowledge(event.target.checked)}
                    />
                    {t('cashForecast.reviewDifference')}
                  </label>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setWalletId('');
                onOpenChange(false);
              }}
              disabled={busy}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                const settlementDate = new Date(`${date}T00:00:00-03:00`);
                if (selected.length === 0) {
                  onConfirm(settlementDate);
                  return;
                }
                payroll.mutate({
                  incomeTransactionId: transactionId,
                  loanTransactionIds: selected,
                  walletAccountId: walletId,
                  settlementDate,
                  ...(parsedNet !== null ? { reportedNetBrl: parsedNet } : {}),
                  acknowledgeDifference: acknowledge,
                });
              }}
              disabled={
                busy ||
                !walletId ||
                !date ||
                options.isLoading ||
                !!options.error ||
                (selected.length > 0 &&
                  (expectedNet === null ||
                    expectedNet.isNegative() ||
                    (net.trim() !== '' && parsedNet === null) ||
                    (differs && !acknowledge)))
              }
            >
              {busy ? t('common.saving') : t('common.confirm')}
            </Button>
          </DialogFooter>
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}
