// src/components/shared/ItemRow.tsx
'use client';

import { Pencil, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type Props = {
  name: string;
  amount: number;
  categoryName?: string | null;
  statusLabel?: string | null;
  progress?: { current: number; total: number } | null;
  variant?: 'neutral' | 'income' | 'expense';
  onEdit?: () => void;
  onDelete?: () => void;
};

function ProgressBar({ current, total }: { current: number; total: number }) {
  const t = useTranslations();
  const pct = Math.round((current / total) * 100);
  const remaining = total - current;

  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-numeric tabular-nums font-medium">
          {t('components-shared-itemrow.installmentProgress', { current, total })}
        </span>
        <span className="text-[10px] font-numeric tabular-nums text-income">{pct}%</span>
      </div>
      <div className="flex h-1.5 gap-px rounded-full overflow-hidden">
        <div className="bg-income rounded-full" style={{ width: `${pct}%` }} />
        <div className="bg-muted rounded-full" style={{ width: `${100 - pct}%` }} />
      </div>
      <span className="text-[10px] text-muted-foreground">
        {t('components-shared-itemrow.remaining', { count: remaining })}
      </span>
    </div>
  );
}

export function ItemRow({
  name,
  amount,
  categoryName,
  statusLabel,
  progress,
  variant = 'neutral',
  onEdit,
  onDelete,
}: Props) {
  const t = useTranslations();
  return (
    <div className="grid grid-cols-[1fr_100px_minmax(140px,1fr)_56px] items-center gap-x-4 py-2.5 border-b border-glass-border last:border-0">
      {/* Col 1: Name + category */}
      <div className="min-w-0">
        <span className="text-sm font-medium truncate block" title={name}>
          {name}
        </span>
        <div className="flex flex-wrap gap-1">
          {categoryName && (
            <Badge variant="outline" className="text-[10px] mt-0.5">
              {categoryName}
            </Badge>
          )}
          {statusLabel && (
            <Badge variant="secondary" className="text-[10px] mt-0.5">
              {statusLabel}
            </Badge>
          )}
        </div>
      </div>

      {/* Col 2: Amount (fixed 100px, right-aligned) */}
      <div className="text-right">
        <AmountDisplay
          amount={amount}
          size="sm"
          variant={variant}
          className="font-semibold font-numeric tabular-nums"
        />
      </div>

      {/* Col 3: Progress bar (empty for non-installments) */}
      <div>{progress && <ProgressBar current={progress.current} total={progress.total} />}</div>

      {/* Col 4: Actions (fixed 56px) */}
      <div className="flex items-center gap-0.5 justify-end">
        {onEdit && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onEdit}
            aria-label={t('components-shared-itemrow.editAriaLabel', { name })}
          >
            <Pencil className="h-3 w-3" />
          </Button>
        )}
        {onDelete && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDelete}
            aria-label={t('components-shared-itemrow.deleteAriaLabel', { name })}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}
