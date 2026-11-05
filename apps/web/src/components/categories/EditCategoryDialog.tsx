'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FormDialog } from '@/components/shared/FormDialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DEFAULT_ENTITY_COLOR } from '@/lib/constants';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category: { id: string; name: string; icon?: string | null; color?: string | null } | null;
};

export function EditCategoryDialog({ open, onOpenChange, category }: Props) {
  const t = useTranslations();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState(DEFAULT_ENTITY_COLOR);

  useEffect(() => {
    if (open && category) {
      setName(category.name);
      setIcon(category.icon || '');
      setColor(category.color || DEFAULT_ENTITY_COLOR);
    }
  }, [open, category]);

  const utils = trpc.useUtils();
  const updateCategory = trpc.category.update.useMutation({
    onSuccess: () => {
      utils.category.list.invalidate();
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  });
  const isPending = updateCategory.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!category || !name.trim()) return;

    updateCategory.mutate({
      id: category.id,
      name: name.trim(),
      ...(icon && { icon: icon.trim() }),
      ...(color && { color: color.trim() }),
    });
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(value) => {
        if (isPending) return;
        onOpenChange(value);
      }}
      title={t('components-categories-editcategorydialog.editCategory')}
      onSubmit={handleSubmit}
      isPending={isPending}
    >
      <div className="space-y-2">
        <Label htmlFor="edit-cat-name">
          {t('components-categories-editcategorydialog.categoryName')}
        </Label>
        <Input id="edit-cat-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="edit-cat-icon">
            {t('components-categories-editcategorydialog.iconEmoji')}
          </Label>
          <Input
            id="edit-cat-icon"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            maxLength={10}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-cat-color">
            {t('components-categories-editcategorydialog.colorLabel')}
          </Label>
          <div className="flex gap-2">
            <Input
              id="edit-cat-color"
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
              title={t('components-categories-editcategorydialog.colorTitle')}
            />
          </div>
        </div>
      </div>
    </FormDialog>
  );
}
