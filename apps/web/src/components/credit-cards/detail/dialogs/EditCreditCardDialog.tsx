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
import { DEFAULT_ENTITY_COLOR } from '@/lib/constants';
import { invalidateCreditCardContext } from '@/lib/invalidate';
import { toMoneyInputString } from '@/lib/money';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: { id: string; name: string; color?: string | null } | null;
  config: {
    closingDay: number;
    dueDay: number;
    creditLimit?: string | null;
    isDueDayVariable?: boolean | null;
  } | null;
};

export function EditCreditCardDialog({ open, onOpenChange, account, config }: Props) {
  const t = useTranslations();
  const [name, setName] = useState('');
  const [closingDay, setClosingDay] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [creditLimit, setCreditLimit] = useState('');
  const [isDueDayVariable, setIsDueDayVariable] = useState(false);
  const [color, setColor] = useState(DEFAULT_ENTITY_COLOR);

  useEffect(() => {
    if (open && account && config) {
      setName(account.name);
      setColor(account.color ?? DEFAULT_ENTITY_COLOR);
      setClosingDay(String(config.closingDay));
      setDueDay(String(config.dueDay));
      setCreditLimit(config.creditLimit ?? '');
      setIsDueDayVariable(config.isDueDayVariable ?? false);
    }
  }, [open, account, config]);

  const utils = trpc.useUtils();
  const updateAccount = trpc.account.update.useMutation();
  const upsertConfig = trpc.creditCard.upsertConfig.useMutation();
  const isPending = updateAccount.isPending || upsertConfig.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!account || !name.trim() || !closingDay || !dueDay) return;

    let limitFormatted: string | undefined;
    if (creditLimit.trim()) {
      const formatted = toMoneyInputString(creditLimit);
      if (!formatted) {
        toast.error(t('common.saveFailed'));
        return;
      }
      limitFormatted = formatted;
    }

    try {
      await updateAccount.mutateAsync({
        id: account.id,
        name: name.trim(),
        color: color.trim(),
      });
      await upsertConfig.mutateAsync({
        accountId: account.id,
        closingDay: Number.parseInt(closingDay, 10),
        dueDay: Number.parseInt(dueDay, 10),
        isDueDayVariable,
        ...(limitFormatted && { creditLimit: limitFormatted }),
      });
      await invalidateCreditCardContext(utils);
      toast.success(t('components-credit-cards-editcreditcarddialog.success'));
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.saveFailed'));
    }
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
          <DialogTitle>{t('components-credit-cards-editcreditcarddialog.title')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" aria-busy={isPending}>
          <fieldset disabled={isPending} aria-busy={isPending} className="contents">
            <div className="space-y-2">
              <Label htmlFor="edit-cc-name">
                {t('components-credit-cards-editcreditcarddialog.nameLabel')}
              </Label>
              <Input
                id="edit-cc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('components-credit-cards-editcreditcarddialog.namePlaceholder')}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-cc-closing">
                  {t('components-credit-cards-editcreditcarddialog.closingDayLabel')}
                </Label>
                <Input
                  id="edit-cc-closing"
                  type="number"
                  min="1"
                  max="31"
                  value={closingDay}
                  onChange={(e) => setClosingDay(e.target.value)}
                  placeholder={t(
                    'components-credit-cards-editcreditcarddialog.closingDayPlaceholder',
                  )}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-cc-due">
                  {t('components-credit-cards-editcreditcarddialog.dueDayLabel')}
                </Label>
                <Input
                  id="edit-cc-due"
                  type="number"
                  min="1"
                  max="31"
                  value={dueDay}
                  onChange={(e) => setDueDay(e.target.value)}
                  placeholder={t('components-credit-cards-editcreditcarddialog.dueDayPlaceholder')}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-cc-limit">
                {t('components-credit-cards-editcreditcarddialog.limitLabel')}
              </Label>
              <Input
                id="edit-cc-limit"
                type="number"
                step="0.01"
                min="0"
                value={creditLimit}
                onChange={(e) => setCreditLimit(e.target.value)}
                placeholder="0,00"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-cc-color">
                {t('components-credit-cards-editcreditcarddialog.colorLabel')}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="edit-cc-color"
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="w-12 p-1"
                />
                <Input
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  placeholder="#000000"
                  maxLength={7}
                  pattern="^#[0-9A-Fa-f]{6}$"
                  title={t('components-credit-cards-editcreditcarddialog.colorTitle')}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="edit-cc-due-variable"
                type="checkbox"
                className="size-4"
                checked={isDueDayVariable}
                onChange={(e) => setIsDueDayVariable(e.target.checked)}
              />
              <Label htmlFor="edit-cc-due-variable">
                {t('components-credit-cards-editcreditcarddialog.dueVariableLabel')}
              </Label>
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
              <Button type="submit" disabled={isPending} aria-busy={isPending}>
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
