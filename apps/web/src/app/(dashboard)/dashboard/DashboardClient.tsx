'use client';

import dynamic from 'next/dynamic';
import { useLocale, useTranslations } from 'next-intl';
import type * as React from 'react';
import { FinancialAlerts } from '@/components/alerts/FinancialAlerts';
import { ActionStrip } from '@/components/dashboard/ActionStrip';
import { HeroCash } from '@/components/dashboard/HeroCash';
import { MonthClosingCard } from '@/components/dashboard/MonthClosingCard';
import { SummaryCards } from '@/components/dashboard/SummaryCards';
import { UpcomingItems } from '@/components/dashboard/UpcomingItems';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { useAutoCreditToast } from '@/hooks/useAutoCreditToast';
import { usePageTitle } from '@/hooks/usePageTitle';

const CashFlowChart = dynamic(
  () => import('@/components/dashboard/CashFlowChart').then((module) => module.CashFlowChart),
  { ssr: false, loading: () => <SkeletonCard /> },
);

/** One orchestrated entrance per page: sections cascade top-down on load. */
function Stagger({ index, children }: { index: number; children: React.ReactNode }) {
  return (
    <div className="stagger-item" style={{ '--stagger-index': index } as React.CSSProperties}>
      {children}
    </div>
  );
}

export function DashboardClient({ month, year }: { month: number; year: number }) {
  const locale = useLocale();
  const t = useTranslations();
  usePageTitle(t('pageTitles.dashboard'));
  useAutoCreditToast();

  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
  const capitalizedMonth = `${monthLabel.charAt(0).toUpperCase()}${monthLabel.slice(1)}`;

  return (
    <div className="space-y-6">
      <PageHeader title={t('pageTitles.dashboard')} subtitle={capitalizedMonth} />

      <Stagger index={0}>
        <HeroCash month={month} year={year} />
      </Stagger>

      <Stagger index={1}>
        <ActionStrip />
      </Stagger>

      <Stagger index={2}>
        <FinancialAlerts month={month} year={year} />
        <SummaryCards month={month} year={year} />
      </Stagger>

      <Stagger index={3}>
        <MonthClosingCard month={month} year={year} />
      </Stagger>

      <Stagger index={4}>
        <UpcomingItems />
      </Stagger>

      <Stagger index={5}>
        <CashFlowChart />
      </Stagger>
    </div>
  );
}
