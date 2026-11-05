'use client';

import type { AppRouter } from '@fc/api';
import { INCOME_CATEGORIES } from '@fc/shared';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
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
import { dateInputToDate, toDateInputValue, todayLocalISO } from '@/lib/dates';
import { invalidateIncomeContext } from '@/lib/invalidate';
import { getIncomeCategoryLabel } from '@/lib/labels';
import { toMoneyInputString } from '@/lib/money';
import { toDisplayNumber } from '@/lib/parse';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';

type IncomeSource = inferRouterOutputs<AppRouter>['income']['list'][number];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: IncomeSource;
};

type IncomeFrequency = 'monthly' | 'biweekly' | 'weekly' | 'annual' | 'one_time';
type IncomeCategory = (typeof INCOME_CATEGORIES)[number];

/** Map the DB frequency enum (which uses 'once') to the form union (which uses 'one_time'). */
function toFormFrequency(freq: string | null | undefined): IncomeFrequency {
  if (freq === 'once') return 'one_time';
  if (
    freq === 'monthly' ||
    freq === 'biweekly' ||
    freq === 'weekly' ||
    freq === 'annual' ||
    freq === 'one_time'
  ) {
    return freq;
  }
  return 'monthly';
}

export function EditIncomeSourceDialog({ open, onOpenChange, source }: Props) {
  const t = useTranslations('components-income-addincomesourcedialog');
  // The category label helper reads from the global `income.categories.*` block.
  const tGlobal = useTranslations();

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<IncomeFrequency>('monthly');
  const [category, setCategory] = useState<IncomeCategory>('salary_clt');
  const [startDate, setStartDate] = useState(() => todayLocalISO());
  const [biweeklyAnchor, setBiweeklyAnchor] = useState('');
  const [paymentDay, setPaymentDay] = useState('');
  const [currency, setCurrency] = useState('BRL');
  const [exchangeRate, setExchangeRate] = useState('');
  const [autoCreditByDate, setAutoCreditByDate] = useState(false);

  // Re-seed the form whenever a different source row is opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only when the row identity changes
  useEffect(() => {
    setDescription(source.account.name);
    setAmount(toDisplayNumber(source.schedule?.amount ?? '0').toFixed(2));
    setFrequency(toFormFrequency(source.config?.frequency));
    setCategory((source.config?.category ?? 'salary_clt') as IncomeCategory);
    setStartDate(toDateInputValue(source.schedule?.startDate, todayLocalISO()));
    setBiweeklyAnchor(source.config?.biweeklyAnchor ?? '');
    setPaymentDay(source.config?.paymentDay?.toString() ?? '');
    setCurrency(source.account.currency);
    setExchangeRate(source.config?.exchangeRate ?? '');
    setAutoCreditByDate(source.config?.autoCreditByDate ?? false);
  }, [source.account.id]);

  const utils = trpc.useUtils();
  const updateMutation = trpc.income.update.useMutation();
  const isPending = updateMutation.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim() || !amount || !startDate || !currency) {
      toast.error(t('fillRequired'));
      return;
    }

    const amountParsed = toMoneyInputString(amount);
    if (!amountParsed) {
      toast.error(t('invalidAmount'));
      return;
    }

    try {
      await updateMutation.mutateAsync({
        accountId: source.account.id,
        description: description.trim(),
        autoCreditByDate,
        amount: amountParsed,
        frequency,
        category,
        startDate: dateInputToDate(startDate),
        currency,
        paymentDay: paymentDay ? parseInt(paymentDay, 10) : null,
        ...(currency !== 'BRL' && exchangeRate ? { exchangeRate } : { exchangeRate: null }),
        ...(frequency === 'biweekly' && { biweeklyAnchor: biweeklyAnchor || startDate }),
      });

      toast.success(t('saveSuccess'));
      await invalidateIncomeContext(utils);
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
        onOpenChange(v);
      }}
      title={t('editTitle')}
      description={t('description')}
      onSubmit={handleSubmit}
      isPending={isPending}
      submitLabel={t('saveChanges')}
      pendingLabel={t('saving')}
      contentClassName="max-w-xl max-h-[90vh] overflow-y-auto"
    >
      {/* Name / description */}
      <div className="space-y-2">
        <Label htmlFor="edit-income-name">{t('name')}</Label>
        <Input
          id="edit-income-name"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
      </div>

      {/* Category */}
      <div className="space-y-2">
        <Label htmlFor="edit-income-category">{t('category')}</Label>
        <Select value={category} onValueChange={(val) => setCategory(val as IncomeCategory)}>
          <SelectTrigger id="edit-income-category">
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

      {/* Amount + Frequency */}
      <div className="grid grid-cols-2 gap-4">
        <MoneyField
          id="edit-income-amount"
          label={t('amount')}
          value={amount}
          onChange={setAmount}
          required
        />

        <div className="space-y-2">
          <Label htmlFor="edit-income-frequency">{t('frequency')}</Label>
          <Select value={frequency} onValueChange={(val) => setFrequency(val as IncomeFrequency)}>
            <SelectTrigger id="edit-income-frequency">
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
          id="edit-income-start-date"
          label={t('startDate')}
          value={startDate}
          onChange={setStartDate}
          required
        />

        <div className="space-y-2">
          <Label htmlFor="edit-income-payment-day">{t('paymentDay')}</Label>
          <Input
            id="edit-income-payment-day"
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
          id="edit-income-biweekly-anchor"
          label={tGlobal('income.form.biweeklyAnchor')}
          value={biweeklyAnchor || startDate}
          onChange={setBiweeklyAnchor}
        />
      )}

      {/* Currency + Exchange rate */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="edit-income-currency">{t('currency')}</Label>
          <Select value={currency} onValueChange={(val) => setCurrency(val ?? 'BRL')}>
            <SelectTrigger id="edit-income-currency">
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
            <Label htmlFor="edit-income-exchange-rate">{t('exchangeRate')}</Label>
            <Input
              id="edit-income-exchange-rate"
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
