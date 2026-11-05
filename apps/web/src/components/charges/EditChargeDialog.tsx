'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DateField } from '@/components/shared/DateField';
import { FormDialog } from '@/components/shared/FormDialog';
import { MoneyField } from '@/components/shared/MoneyField';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { dateInputToDate, toDateInputValue } from '@/lib/dates';
import { invalidateChargeContext } from '@/lib/invalidate';
import { toMoneyInputString } from '@/lib/money';
import { toDisplayNumber } from '@/lib/parse';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';

type Charge = inferRouterOutputs<AppRouter>['charges']['list']['fixed'][number];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  charge: Charge;
};

export function EditChargeDialog({ open, onOpenChange, charge }: Props) {
  const t = useTranslations('components-charges-editchargedialog');
  // Shared field labels live in the add-dialog namespace.
  const tFields = useTranslations('components-charges-addchargedialog');
  const tGlobal = useTranslations();

  const isOnce = charge.frequency === 'once';

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Re-seed the form whenever a different charge row is opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only when the row identity changes
  useEffect(() => {
    setDescription(charge.description);
    setAmount(toDisplayNumber(charge.amount).toFixed(2));
    setDueDay(charge.dueDay?.toString() ?? '');
    setStartDate(toDateInputValue(charge.startDate));
    setEndDate(toDateInputValue(charge.endDate));
  }, [charge.id]);

  const utils = trpc.useUtils();
  const updateMutation = trpc.charges.update.useMutation();
  const isPending = updateMutation.isPending;

  async function handleSubmit() {
    if (!description.trim() || !amount) {
      toast.error(tFields('fillRequired'));
      return;
    }

    const amountParsed = toMoneyInputString(amount);
    if (!amountParsed) {
      toast.error(tFields('invalidAmount'));
      return;
    }

    try {
      await updateMutation.mutateAsync({
        scheduleId: charge.id,
        description: description.trim(),
        amount: amountParsed,
        ...(dueDay && { dueDay: parseInt(dueDay, 10) }),
        endDate: endDate ? dateInputToDate(endDate) : null,
      });

      toast.success(tFields('saveSuccess'));
      await invalidateChargeContext(utils);
      onOpenChange(false);
    } catch (error) {
      toast.error(resolveTRPCError(error, tGlobal));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('title')}
      description={tFields('description')}
      onSubmit={handleSubmit}
      isPending={isPending}
      submitLabel={t('saveChanges')}
      pendingLabel={tFields('saving')}
      contentClassName="max-w-xl max-h-[90vh] overflow-y-auto"
    >
      {/* Description */}
      <div className="space-y-2">
        <Label htmlFor="edit-charge-description">{tFields('description')}</Label>
        <Input
          id="edit-charge-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
      </div>

      {/* Amount + Due day */}
      <div className="grid grid-cols-2 gap-4">
        <MoneyField
          id="edit-charge-amount"
          label={tFields('amount')}
          value={amount}
          onChange={setAmount}
          required
        />

        <div className="space-y-2">
          <Label htmlFor="edit-charge-due-day">{tFields('dueDay')}</Label>
          <Input
            id="edit-charge-due-day"
            type="number"
            min="1"
            max="31"
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value)}
          />
        </div>
      </div>

      {/* Start date (read-only context) + End date (fixed only) */}
      <div className="grid grid-cols-2 gap-4">
        <DateField
          id="edit-charge-start-date"
          label={isOnce ? tFields('date') : tFields('startDate')}
          value={startDate}
          disabled
          readOnly
        />

        {!isOnce && (
          <DateField
            id="edit-charge-end-date"
            label={tFields('endDate')}
            value={endDate}
            onChange={setEndDate}
          />
        )}
      </div>
    </FormDialog>
  );
}
