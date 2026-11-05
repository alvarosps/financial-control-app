'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DateField } from '@/components/shared/DateField';
import { FormDialog } from '@/components/shared/FormDialog';
import { MoneyField } from '@/components/shared/MoneyField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { dateInputToDate, todayLocalISO } from '@/lib/dates';
import { invalidateChargeContext } from '@/lib/invalidate';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';
import { toArray } from '@/lib/utils';

type ChargeKind = 'fixed' | 'oneTime';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultKind?: ChargeKind;
};

export function AddChargeDialog({ open, onOpenChange, defaultKind = 'fixed' }: Props) {
  const t = useTranslations('components-charges-addchargedialog');
  const tGlobal = useTranslations();

  const [kind, setKind] = useState<ChargeKind>(defaultKind);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [startDate, setStartDate] = useState(() => todayLocalISO());
  const [dueDay, setDueDay] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isPaid, setIsPaid] = useState(false);

  // The dialog stays mounted in ChargesClient, so the initial `useState(defaultKind)`
  // only applies once. Re-sync the toggle to the requested kind every time it opens
  // (e.g. "Nova fixa" → fixed, "Novo gasto único" → oneTime).
  useEffect(() => {
    if (open) setKind(defaultKind);
  }, [open, defaultKind]);

  const utils = trpc.useUtils();
  const createFixedMutation = trpc.charges.createFixed.useMutation();
  const createOneTimeMutation = trpc.charges.createOneTime.useMutation();
  const isPending = createFixedMutation.isPending || createOneTimeMutation.isPending;
  const { data: rawAccounts } = trpc.account.list.useQuery();
  const sourceAccounts = toArray(rawAccounts).filter(
    (a) => (a.type === 'checking' || a.type === 'savings') && a.isActive,
  );

  function resetForm() {
    setKind(defaultKind);
    setDescription('');
    setAmount('');
    setSourceAccountId('');
    setStartDate(todayLocalISO());
    setDueDay('');
    setEndDate('');
    setIsPaid(false);
  }

  async function handleSubmit() {
    if (!description.trim() || !amount || !sourceAccountId || !startDate) {
      toast.error(t('fillRequired'));
      return;
    }
    if (kind === 'fixed' && !dueDay) {
      toast.error(t('fillRequired'));
      return;
    }

    const amountParsed = toMoneyInputString(amount);
    if (!amountParsed) {
      toast.error(t('invalidAmount'));
      return;
    }

    try {
      if (kind === 'fixed') {
        await createFixedMutation.mutateAsync({
          description: description.trim(),
          amount: amountParsed,
          sourceAccountId,
          startDate: dateInputToDate(startDate),
          dueDay: parseInt(dueDay, 10),
          ...(endDate && { endDate: dateInputToDate(endDate) }),
        });
      } else {
        await createOneTimeMutation.mutateAsync({
          description: description.trim(),
          amount: amountParsed,
          sourceAccountId,
          date: dateInputToDate(startDate),
          ...(dueDay && { dueDay: parseInt(dueDay, 10) }),
          ...(isPaid && { isPaid: true }),
        });
      }

      toast.success(t('saveSuccess'));
      await invalidateChargeContext(utils);
      resetForm();
      onOpenChange(false);
    } catch (error) {
      toast.error(resolveTRPCError(error, tGlobal));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        if (!v) resetForm();
        onOpenChange(v);
      }}
      title={kind === 'fixed' ? t('titleFixed') : t('titleOneTime')}
      description={t('description')}
      onSubmit={handleSubmit}
      isPending={isPending}
      submitLabel={t('add')}
      pendingLabel={t('saving')}
      contentClassName="max-w-xl max-h-[90vh] overflow-y-auto"
    >
      {/* Kind toggle */}
      <div className="space-y-2">
        <Label>{t('kind')}</Label>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={kind === 'fixed' ? 'brand' : 'outline'}
            onClick={() => setKind('fixed')}
          >
            {t('kindFixed')}
          </Button>
          <Button
            type="button"
            variant={kind === 'oneTime' ? 'brand' : 'outline'}
            onClick={() => setKind('oneTime')}
          >
            {t('kindOneTime')}
          </Button>
        </div>
      </div>
      {/* Description */}
      <div className="space-y-2">
        <Label htmlFor="charge-description">{t('description')}</Label>
        <Input
          id="charge-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
      </div>
      {/* Amount + Source account */}
      <div className="grid grid-cols-2 gap-4">
        <MoneyField
          id="charge-amount"
          label={t('amount')}
          value={amount}
          onChange={setAmount}
          required
        />

        <div className="space-y-2">
          <Label htmlFor="charge-source">{t('sourceAccount')}</Label>
          <Select value={sourceAccountId} onValueChange={(val) => setSourceAccountId(val ?? '')}>
            <SelectTrigger id="charge-source">
              <SelectValue placeholder={t('selectAccount')} />
            </SelectTrigger>
            <SelectContent>
              {sourceAccounts.map((acc) => (
                <SelectItem key={acc.id} value={acc.id}>
                  {acc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {/* Date + Due day */}
      <div className="grid grid-cols-2 gap-4">
        <DateField
          id="charge-date"
          label={kind === 'fixed' ? t('startDate') : t('date')}
          value={startDate}
          onChange={setStartDate}
          required
        />

        <div className="space-y-2">
          <Label htmlFor="charge-due-day">{t('dueDay')}</Label>
          <Input
            id="charge-due-day"
            type="number"
            min="1"
            max="31"
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value)}
            required={kind === 'fixed'}
          />
        </div>
      </div>
      {/* End date (fixed only) */}
      {kind === 'fixed' && (
        <DateField
          id="charge-end-date"
          label={t('endDate')}
          value={endDate}
          onChange={setEndDate}
        />
      )}
      {/* Already paid (one-time only) */}
      {kind === 'oneTime' && (
        <div className="flex items-center gap-2">
          <input
            id="charge-already-paid"
            type="checkbox"
            className="size-4"
            checked={isPaid}
            onChange={(e) => setIsPaid(e.target.checked)}
          />
          <Label htmlFor="charge-already-paid">{t('alreadyPaid')}</Label>
        </div>
      )}
    </FormDialog>
  );
}
