'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { parseMonthParam, parseYearParam } from '@/lib/month-params';

export type MonthNavigation = {
  month: number;
  year: number;
  setMonthYear: (month: number, year: number) => void;
  goToPreviousMonth: () => void;
  goToNextMonth: () => void;
};

export function writeMonthYearToUrl(month: number, year: number): void {
  const params = new URLSearchParams(window.location.search);
  params.set('month', String(month));
  params.set('year', String(year));
  window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
}

export function useMonthNavigation(initialMonth?: number, initialYear?: number): MonthNavigation {
  const searchParams = useSearchParams();
  const now = useMemo(() => new Date(), []);
  const month = parseMonthParam(searchParams.get('month')) ?? initialMonth ?? now.getMonth() + 1;
  const year = parseYearParam(searchParams.get('year')) ?? initialYear ?? now.getFullYear();

  const setMonthYear = useCallback((nextMonth: number, nextYear: number) => {
    writeMonthYearToUrl(nextMonth, nextYear);
  }, []);

  const goToPreviousMonth = useCallback(() => {
    if (month === 1) setMonthYear(12, year - 1);
    else setMonthYear(month - 1, year);
  }, [month, setMonthYear, year]);

  const goToNextMonth = useCallback(() => {
    if (month === 12) setMonthYear(1, year + 1);
    else setMonthYear(month + 1, year);
  }, [month, setMonthYear, year]);

  return { month, year, setMonthYear, goToPreviousMonth, goToNextMonth };
}
