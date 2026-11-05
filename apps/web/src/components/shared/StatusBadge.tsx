'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

type StatusBadgeProps = {
  status: 'paid' | 'pending' | 'overdue';
  className?: string;
};

const statusClasses: Record<StatusBadgeProps['status'], string> = {
  paid: 'bg-income/15 text-income',
  pending: 'bg-warning/15 text-warning',
  overdue: 'bg-expense/15 text-expense',
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const t = useTranslations();
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        statusClasses[status],
        className,
      )}
    >
      {t(`common.${status}`)}
    </span>
  );
}
