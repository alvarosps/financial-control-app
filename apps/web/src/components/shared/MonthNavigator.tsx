'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { getMonthName } from '@/lib/labels';

export type MonthNavigatorProps = {
  month: number;
  year: number;
  onPrev: () => void;
  onNext: () => void;
  buttonSize?: 'icon' | 'icon-lg';
};

export function MonthNavigator({
  month,
  year,
  onPrev,
  onNext,
  buttonSize = 'icon',
}: MonthNavigatorProps) {
  const locale = useLocale();
  const t = useTranslations();
  return (
    <>
      <Button
        variant="outline"
        size={buttonSize}
        className="touch-hit"
        onClick={onPrev}
        aria-label={t('common.previousMonth')}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span className="min-w-[140px] text-center text-sm font-medium" aria-live="polite">
        {getMonthName(month, locale)} {year}
      </span>
      <Button
        variant="outline"
        size={buttonSize}
        className="touch-hit"
        onClick={onNext}
        aria-label={t('common.nextMonth')}
      >
        <ChevronRight className="size-4" />
      </Button>
    </>
  );
}
