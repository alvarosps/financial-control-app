'use client';

import type { MonthRef } from '@fc/shared';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type Props = {
  id: string;
  label: string;
  value: MonthRef;
  onChange: (value: MonthRef) => void;
  /** Inclusive year span offered around the current year. */
  yearSpan?: number;
  /**
   * When true, show a muted note if the selected month is the actual current
   * month — that month is folded into the opening balance, so a lever placed on
   * it won't appear as its own projection row.
   */
  warnOnCurrentMonth?: boolean;
};

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

export function MonthYearPicker({
  id,
  label,
  value,
  onChange,
  yearSpan = 3,
  warnOnCurrentMonth = false,
}: Props) {
  const t = useTranslations();
  const now = new Date();
  const currentYear = now.getFullYear();
  const isCurrentMonth = value.month === now.getMonth() + 1 && value.year === currentYear;
  // Always span the full range from the earliest to the latest year we must show
  // so a saved scenario's year is offered whether it falls below the current year
  // or beyond the default window (otherwise the year Select renders blank).
  const minYear = Math.min(currentYear, value.year);
  const maxYear = Math.max(currentYear + yearSpan, value.year);
  const years: number[] = [];
  for (let y = minYear; y <= maxYear; y += 1) years.push(y);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-month`} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <div className="flex gap-2">
        <Select
          value={String(value.month)}
          onValueChange={(v) => onChange({ ...value, month: Number(v ?? value.month) })}
        >
          <SelectTrigger id={`${id}-month`} className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTHS.map((m) => (
              <SelectItem key={m} value={String(m)}>
                {t(`simulator.month.${m}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(value.year)}
          onValueChange={(v) => onChange({ ...value, year: Number(v ?? value.year) })}
        >
          <SelectTrigger id={`${id}-year`} className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {warnOnCurrentMonth && isCurrentMonth && (
        <p className="text-xs text-muted-foreground">{t('simulator.monthFoldsIntoOpening')}</p>
      )}
    </div>
  );
}
