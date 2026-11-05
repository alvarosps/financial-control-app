// src/components/credit-cards/detail/InstallmentList.tsx
'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { ItemRow } from '@/components/shared/ItemRow';
import { fuzzyFilter } from '@/lib/fuzzy-search';
import { safeParseFloat } from '@/lib/parse';

type Installment = {
  id: string;
  scheduledTransactionId?: string | null;
  description: string;
  amount: string | number;
  totalOccurrences: number | null;
  startingOccurrence: number | null;
  categoryId: string | null;
  canEdit?: boolean;
  /** First-installment date of the schedule ≈ the purchase date (primary sort). */
  startDate?: string | Date | null;
};

type Category = {
  id: string;
  name: string;
};

type Props = {
  items: Installment[];
  categories: Category[];
  onEdit: (id: string) => void;
  onDelete: (id: string, name: string, isScheduled: boolean) => void;
};

export function InstallmentList({ items, categories, onEdit, onDelete }: Props) {
  const t = useTranslations();
  const [search, setSearch] = useState('');

  const categoryMap = useMemo(() => {
    const map = new Map<string, string>();
    categories.forEach((c) => {
      map.set(c.id, c.name);
    });
    return map;
  }, [categories]);

  // Primary: oldest purchase first (earliest start_date). Secondary (previous
  // behaviour): current installment descending (most advanced first), then
  // remaining ascending. Items without a start date sort last.
  const sorted = useMemo(() => {
    const purchaseTime = (d: string | Date | null | undefined) =>
      d == null ? Number.POSITIVE_INFINITY : new Date(d).getTime();
    return [...items].sort((a, b) => {
      const dateA = purchaseTime(a.startDate);
      const dateB = purchaseTime(b.startDate);
      if (dateA !== dateB) return dateA - dateB;
      const currentA = a.startingOccurrence ?? 0;
      const currentB = b.startingOccurrence ?? 0;
      if (currentB !== currentA) return currentB - currentA;
      const remainA = (a.totalOccurrences ?? 999999) - currentA;
      const remainB = (b.totalOccurrences ?? 999999) - currentB;
      return remainA - remainB;
    });
  }, [items]);

  const filtered = useMemo(() => {
    return fuzzyFilter(sorted, search, ['description']);
  }, [sorted, search]);

  return (
    <div>
      {items.length > 5 && (
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('components-credit-cards-detail-installmentlist.searchInstallment')}
          aria-label={t('components-credit-cards-detail-installmentlist.searchInstallments')}
          className="mb-2 h-7 w-full rounded-md border border-glass-border bg-glass-bg px-2.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      )}
      <div>
        {filtered.map((inst) => (
          <ItemRow
            key={inst.id}
            name={inst.description}
            amount={Math.abs(safeParseFloat(inst.amount))}
            categoryName={inst.categoryId ? categoryMap.get(inst.categoryId) : null}
            progress={
              inst.totalOccurrences && inst.startingOccurrence
                ? { current: inst.startingOccurrence, total: inst.totalOccurrences }
                : null
            }
            onEdit={
              inst.canEdit !== false
                ? () => onEdit(inst.scheduledTransactionId ?? inst.id)
                : undefined
            }
            onDelete={() =>
              onDelete(
                inst.scheduledTransactionId ?? inst.id,
                inst.description,
                !!inst.scheduledTransactionId,
              )
            }
          />
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            {t('components-credit-cards-detail-installmentlist.noInstallmentsFound')}
          </p>
        )}
      </div>
    </div>
  );
}
