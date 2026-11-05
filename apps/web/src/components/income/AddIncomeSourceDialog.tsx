'use client';

import { INCOME_CATEGORIES } from '@fc/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { DateField } from '@/components/shared/DateField';
import { FormDialog } from '@/components/shared/FormDialog';
import { MoneyField } from '@/components/shared/MoneyField';
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
import { invalidateIncomeContext } from '@/lib/invalidate';
import { getIncomeCategoryLabel } from '@/lib/labels';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';
import { toArray } from '@/lib/utils';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type IncomeFrequency = 'monthly' | 'biweekly' | 'weekly' | 'annual' | 'one_time';
type IncomeCategory = (typeof INCOME_CATEGORIES)[number];

export function AddIncomeSourceDialog({ open, onOpenChange }: Props) {
  const t = useTranslations('components-income-addincomesourcedialog');
  // The category label helper reads from the global `income.categories.*` block.
  const tGlobal = useTranslations();

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<IncomeFrequency>('monthly');
  const [category, setCategory] = useState<IncomeCategory>('salary_clt');
  const [destinationAccountId, setDestinationAccountId] = useState('');
  const [startDate, setStartDate] = useState(() => todayLocalISO());
  const [biweeklyAnchor, setBiweeklyAnchor] = useState('');
  const [paymentDay, setPaymentDay] = useState('');
  const [currency, setCurrency] = useState('BRL');
  const [exchangeRate, setExchangeRate] = useState('');
  const [autoCreditByDate, setAutoCreditByDate] = useState(false);

  const utils = trpc.useUtils();
  const createMutation = trpc.income.create.useMutation();
  const isPending = createMutation.isPending;
  const { data: rawAccounts } = trpc.account.list.useQuery();
  const checkingAccounts = toArray(rawAccounts).filter(
    (a) => (a.type === 'checking' || a.type === 'savings') && a.isActive,
  );

  function resetForm() {
    setDescription('');
    setAmount('');
    setFrequency('monthly');
    setCategory('salary_clt');
    setDestinationAccountId('');
    setStartDate(todayLocalISO());
    setBiweeklyAnchor('');
    setPaymentDay('');
    setCurrency('BRL');
    setExchangeRate('');
    setAutoCreditByDate(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim() || !amount || !destinationAccountId || !startDate || !currency) {
      toast.error(t('fillRequired'));
      return;
    }

    const amountParsed = toMoneyInputString(amount);
    if (!amountParsed) {
      toast.error(t('invalidAmount'));
      return;
    }

    try {
      await createMutation.mutateAsync({
        description: description.trim(),
        autoCreditByDate,
        amount: amountParsed,
        frequency,
        category,
        destinationAccountId,
        startDate: dateInputToDate(startDate),
        currency,
        ...(paymentDay && { paymentDay: parseInt(paymentDay, 10) }),
        ...(currency !== 'BRL' && exchangeRate && { exchangeRate }),
        ...(frequency === 'biweekly' && { biweeklyAnchor: biweeklyAnchor || startDate }),
      });

      toast.success(t('saveSuccess'));
      await invalidateIncomeContext(utils);
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
      title={t('title')}
      description={t('description')}
      onSubmit={handleSubmit}
      isPending={isPending}
      submitLabel={t('add')}
      pendingLabel={t('saving')}
      contentClassName="max-w-xl max-h-[90vh] overflow-y-auto"
    >
      {/* Name / description */}
      <div className="space-y-2">
        <Label htmlFor="income-name">{t('name')}</Label>
        <Input
          id="income-name"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
      </div>

      {/* Category + Destination account */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="income-category">{t('category')}</Label>
          <Select value={category} onValueChange={(val) => setCategory(val as IncomeCategory)}>
            <SelectTrigger id="income-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INCOME_CATEGORIES.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {getIncomeCategoryLabel(tGlobal, cat)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="income-destination">{t('destinationAccount')}</Label>
          <Select
            value={destinationAccountId}
            onValueChange={(val) => setDestinationAccountId(val ?? '')}
          >
            <SelectTrigger id="income-destination">
              <SelectValue placeholder={t('selectAccount')} />
            </SelectTrigger>
            <SelectContent>
              {checkingAccounts.map((acc) => (
                <SelectItem key={acc.id} value={acc.id}>
                  {acc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Amount + Frequency */}
      <div className="grid grid-cols-2 gap-4">
        <MoneyField
          id="income-amount"
          label={t('amount')}
          value={amount}
          onChange={setAmount}
          required
        />

        <div className="space-y-2">
          <Label htmlFor="income-frequency">{t('frequency')}</Label>
          <Select value={frequency} onValueChange={(val) => setFrequency(val as IncomeFrequency)}>
            <SelectTrigger id="income-frequency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">{t('freqMonthly')}</SelectItem>
              <SelectItem value="biweekly">{t('freqBiweekly')}</SelectItem>
              <SelectItem value="weekly">{t('freqWeekly')}</SelectItem>
              <SelectItem value="annual">{t('freqAnnual')}</SelectItem>
              <SelectItem value="one_time">{t('freqOnce')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Start date + Payment day */}
      <div className="grid grid-cols-2 gap-4">
        <DateField
          id="income-start-date"
          label={t('startDate')}
          value={startDate}
          onChange={setStartDate}
          required
        />

        <div className="space-y-2">
          <Label htmlFor="income-payment-day">{t('paymentDay')}</Label>
          <Input
            id="income-payment-day"
            type="number"
            min="1"
            max="31"
            value={paymentDay}
            onChange={(e) => setPaymentDay(e.target.value)}
          />
        </div>
      </div>

      {/* Biweekly anchor (only for biweekly cadence) */}
      {frequency === 'biweekly' && (
        <DateField
          id="income-biweekly-anchor"
          label={tGlobal('income.form.biweeklyAnchor')}
          value={biweeklyAnchor || startDate}
          onChange={setBiweeklyAnchor}
        />
      )}

      {/* Currency + Exchange rate */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="income-currency">{t('currency')}</Label>
          <Select value={currency} onValueChange={(val) => setCurrency(val ?? 'BRL')}>
            <SelectTrigger id="income-currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="BRL">{tGlobal('currencies.brl')}</SelectItem>
              <SelectItem value="USD">{tGlobal('currencies.usd')}</SelectItem>
              <SelectItem value="EUR">{tGlobal('currencies.eur')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {currency !== 'BRL' && (
          <div className="space-y-2">
            <Label htmlFor="income-exchange-rate">{t('exchangeRate')}</Label>
            <Input
              id="income-exchange-rate"
              type="number"
              step="0.0001"
              min="0"
              value={exchangeRate}
              onChange={(e) => setExchangeRate(e.target.value)}
              placeholder="0,00"
            />
          </div>
        )}
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoCreditByDate}
          onChange={(event) => setAutoCreditByDate(event.target.checked)}
        />
        {tGlobal('cashForecast.autoCreditWarning')}
      </label>
    </FormDialog>
  );
}
