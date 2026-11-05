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
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { toMoneyInputString } from '@/lib/money';
import { invalidateDashboard, trpc } from '@/lib/trpc/client';

export type EditReceivedTarget = {
  transactionId: string;
  /** Occurrence label ("Inscyth — 05/06/2026"). */
  label: string;
  /** Current BRL amount, pre-filled into the input ("5180.00"). */
  amountBrl: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EditReceivedTarget | null;
};

export function EditReceivedAmountDialog({ open, onOpenChange, target }: Props) {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const [amountBrl, setAmountBrl] = useState('');

  useEffect(() => {
    if (target) setAmountBrl(target.amountBrl);
  }, [target]);

  const mutation = trpc.income.editReceivedAmount.useMutation({
    onSuccess: (result) => {
      toast.success(t('income.editReceived.success'));
      // The wallet's displayed cash is anchored: a pre-anchor edit updates
      // reports but not the current balance. Tell the user so the unchanged
      // wallet figure is not mistaken for a bug.
      if (result.affectsCurrentBalance === false) {
        toast(t('income.editReceived.anchoredHint'));
      }
      utils.income.occurrences.invalidate();
      utils.account.walletsOverview.invalidate();
      utils.account.list.invalidate();
      invalidateDashboard(utils);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message || t('income.editReceived.error'));
    },
  });

  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard(mutation);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    const parsed = toMoneyInputString(amountBrl);
    if (!parsed) {
      toast.error(t('income.markReceived.invalidAmount'));
      return;
    }
    mutation.mutate({ transactionId: target.transactionId, amountBrl: parsed });
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
          <DialogTitle>{t('income.editReceived.title')}</DialogTitle>
        </DialogHeader>
        <form {...formProps} onSubmit={handleSubmit} className="space-y-3">
          <fieldset {...fieldsetProps} className="contents">
            {target && <p className="text-sm font-medium">{target.label}</p>}
            <div>
              <Label htmlFor="edit-received-brl" className="text-xs text-muted-foreground">
                {t('income.editReceived.amountLabel')}
              </Label>
              <Input
                id="edit-received-brl"
                inputMode="decimal"
                value={amountBrl}
                onChange={(e) => setAmountBrl(e.target.value)}
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
              <Button type="submit" {...submitProps}>
                {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                {isPending ? t('common.saving') : t('income.editReceived.action')}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
