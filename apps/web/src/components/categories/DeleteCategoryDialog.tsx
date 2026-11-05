'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMutationFormGuard } from '@/hooks/useMutationFormGuard';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category: { id: string; name: string } | null;
};

export function DeleteCategoryDialog({ open, onOpenChange, category }: Props) {
  const t = useTranslations();
  const utils = trpc.useUtils();

  const deleteCategory = trpc.category.delete.useMutation({
    onMutate: async (vars) => {
      await utils.category.list.cancel();
      const prev = utils.category.list.getData();
      utils.category.list.setData(undefined, (old) =>
        Array.isArray(old) ? old.filter((c) => c.id !== vars.id) : old,
      );
      return { prev };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.prev) utils.category.list.setData(undefined, ctx.prev);
      toast.error(error.message || t('components-categories-deletecategorydialog.deleteError'));
    },
    onSuccess: () => {
      toast.success(t('components-categories-deletecategorydialog.categoryDeletedSuccessfully'));
      onOpenChange(false);
    },
    onSettled: () => {
      utils.category.list.invalidate();
    },
  });

  const { isPending, submitProps } = useMutationFormGuard(deleteCategory);

  function handleConfirm() {
    if (!category) return;
    deleteCategory.mutate({ id: category.id });
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
          <DialogTitle>
            {t('components-categories-deletecategorydialog.deleteCategory')}
          </DialogTitle>
          <DialogDescription>
            {t('components-categories-deletecategorydialog.confirmDescription', {
              name: category?.name ?? '',
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t('components-categories-deletecategorydialog.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} {...submitProps}>
            {isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            {isPending ? t('common.deleting') : t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
