'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormDialog } from '@/components/shared/FormDialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DEFAULT_ENTITY_COLOR } from '@/lib/constants';
import { trpc } from '@/lib/trpc/client';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AddCategoryDialog({ open, onOpenChange }: Props) {
  const t = useTranslations();
  const [name, setName] = useState('');
  const [type, setType] = useState<'revenue' | 'expense'>('expense');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState(DEFAULT_ENTITY_COLOR);

  const utils = trpc.useUtils();
  const createCategory = trpc.category.create.useMutation({
    onSuccess: () => {
      utils.category.list.invalidate();
      resetForm();
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message || t('common.saveFailed'));
    },
  });
  const isPending = createCategory.isPending;

  function resetForm() {
    setName('');
    setType('expense');
    setIcon('');
    setColor(DEFAULT_ENTITY_COLOR);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    createCategory.mutate({
      name: name.trim(),
      type,
      ...(icon && { icon: icon.trim() }),
      ...(color && { color: color.trim() }),
    });
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(value) => {
        if (isPending) return;
        if (!value) resetForm();
        onOpenChange(value);
      }}
      title={t('components-categories-addcategorydialog.newCategory')}
      onSubmit={handleSubmit}
      isPending={isPending}
      submitLabel={t('common.add')}
    >
      <div className="space-y-2">
        <Label htmlFor="cat-name">
          {t('components-categories-addcategorydialog.categoryName')}
        </Label>
        <Input
          id="cat-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('components-categories-addcategorydialog.namePlaceholder')}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cat-type">{t('components-categories-addcategorydialog.typeLabel')}</Label>
        <Select value={type} onValueChange={(value) => setType(value as 'revenue' | 'expense')}>
          <SelectTrigger id="cat-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="expense">
              {t('components-categories-addcategorydialog.expense')}
            </SelectItem>
            <SelectItem value="revenue">
              {t('components-categories-addcategorydialog.typeRevenue')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="cat-icon">{t('components-categories-addcategorydialog.iconEmoji')}</Label>
          <Input
            id="cat-icon"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            placeholder={t('components-categories-addcategorydialog.iconPlaceholder')}
            maxLength={10}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cat-color">
            {t('components-categories-addcategorydialog.colorLabel')}
          </Label>
          <div className="flex gap-2">
            <Input
              id="cat-color"
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
              title={t('components-categories-addcategorydialog.colorTitle')}
            />
          </div>
        </div>
      </div>
    </FormDialog>
  );
}
