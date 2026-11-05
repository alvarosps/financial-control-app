'use client';

import { Loader2 } from 'lucide-react';
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
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { invalidateCreditCardContext } from '@/lib/invalidate';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentCardId: string;
};

export function AddAdditionalCardDialog({ open, onOpenChange, parentCardId }: Props) {
  const t = useTranslations();
  const [name, setName] = useState('');

  const utils = trpc.useUtils();
  // Creating an additional card only strictly invalidates account.list and
  // creditCard.listConfigs, but we use the canonical helper for uniformity —
  // the extra invalidations are cheap and eliminate drift if the parent card
  // panel ever surfaces the child in a bill/summary.
  const create = trpc.account.create.useMutation({
    onSuccess: async () => {
      await invalidateCreditCardContext(utils);
      setName('');
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  });

  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard(create);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({
      name: name.trim(),
      type: 'credit_card',
      currency: 'BRL',
      parentAccountId: parentCardId,
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        if (!v) setName('');
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('components-credit-cards-detail-dialogs-addadditionalcarddialog.addAdditionalCard')}
          </DialogTitle>
        </DialogHeader>
        <form {...formProps} onSubmit={handleSubmit} className="space-y-3">
          <fieldset {...fieldsetProps} className="contents">
            <div>
              <Label htmlFor="additional-card-name" className="text-xs text-muted-foreground">
                {t('components-credit-cards-detail-dialogs-addadditionalcarddialog.cardName')}
              </Label>
              <Input
                id="additional-card-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t(
                  'components-credit-cards-detail-dialogs-addadditionalcarddialog.eGAdditionalCard',
                )}
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
                {t('components-credit-cards-detail-dialogs-addadditionalcarddialog.cancel')}
              </Button>
              <Button type="submit" {...submitProps}>
                {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                {isPending
                  ? t('common.creating')
                  : t('components-credit-cards-detail-dialogs-addadditionalcarddialog.create-card')}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
