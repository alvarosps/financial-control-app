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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  configId: string;
  creditCardAccounts: { id: string; name: string }[];
  onSuccess: () => void;
};

export function AddBorrowedCardDialog({
  open,
  onOpenChange,
  configId,
  creditCardAccounts,
  onSuccess,
}: Props) {
  const t = useTranslations();
  const [cardAccountId, setCardAccountId] = useState('');
  const [cardDescription, setCardDescription] = useState('');

  const resetForm = () => {
    setCardAccountId('');
    setCardDescription('');
  };

  const mutation = trpc.familyLoan.addBorrowedCard.useMutation({
    onSuccess: () => {
      onSuccess();
      onOpenChange(false);
      setCardAccountId('');
      setCardDescription('');
    },
    onError: (error) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  });

  const { isPending, fieldsetProps, submitProps, formProps } = useMutationFormGuard(mutation);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        if (!v) resetForm();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('components-family-loans-addborrowedcarddialog.addBorrowedCard')}
          </DialogTitle>
        </DialogHeader>
        <form
          {...formProps}
          onSubmit={(e) => {
            e.preventDefault();
            if (!cardAccountId) return;
            mutation.mutate({
              configId,
              creditCardAccountId: cardAccountId,
              ...(cardDescription ? { description: cardDescription.trim() } : {}),
            });
          }}
          className="space-y-3"
        >
          <fieldset {...fieldsetProps} className="contents">
            <div>
              <Label htmlFor="card-account" className="text-xs text-muted-foreground">
                {t('components-family-loans-addborrowedcarddialog.creditCard')}
              </Label>
              <Select value={cardAccountId} onValueChange={(v) => setCardAccountId(v ?? '')}>
                <SelectTrigger id="card-account" className="w-full">
                  <SelectValue
                    placeholder={t('components-family-loans-addborrowedcarddialog.selectTheCard')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {creditCardAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="card-description" className="text-xs text-muted-foreground">
                {t('components-family-loans-addborrowedcarddialog.descriptionOptional')}
              </Label>
              <Input
                id="card-description"
                value={cardDescription}
                onChange={(e) => setCardDescription(e.target.value)}
                placeholder={t('components-family-loans-addborrowedcarddialog.eGJohnS')}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                {t('components-family-loans-addborrowedcarddialog.cancel')}
              </Button>
              <Button type="submit" {...submitProps} disabled={isPending || !cardAccountId}>
                {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                {isPending ? t('common.adding') : t('common.add')}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
