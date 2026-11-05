'use client';

import { ChevronLeft, ChevronRight, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cardColor } from '@/lib/card-color';
import { formatCurrency } from '@/lib/format';
import { getMonthName } from '@/lib/labels';
import { safeParseFloat } from '@/lib/parse';
import { cn } from '@/lib/utils';
import { BillStatus } from './BillStatus';
import type { BillData } from './types';

/**
 * Consolidated fatura for a principal card with additional cards. When present,
 * the panel shows the consolidated total/paid-state (the amount actually paid
 * when "Pagar Fatura" cascades to the children) and a per-card breakdown
 * instead of the principal's individual transactions.
 */
export type ConsolidatedPanel = {
  total: number;
  isPaid: boolean;
  transactionCount: number;
  breakdown: { cardId: string; name: string; color?: string | null; total: number }[];
};

type Props = {
  bill: BillData | null | undefined;
  consolidated?: ConsolidatedPanel | null;
  month: number;
  year: number;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onPayBill: () => void;
  isLoading?: boolean;
};

export function BillPanel({
  bill,
  consolidated,
  month,
  year,
  onPrevMonth,
  onNextMonth,
  onPayBill,
  isLoading,
}: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Reset "show more" when month changes
  useEffect(() => {
    setShowAll(false);
  }, []);

  // When the card has additional cards, the panel reflects the CONSOLIDATED
  // fatura (total + paid-state) since that is what the pay button settles.
  const total = consolidated ? consolidated.total : (bill?.total ?? 0);
  const isPaid = consolidated ? consolidated.isPaid : (bill?.isPaid ?? false);
  const itemCount = consolidated ? consolidated.transactionCount : (bill?.transactionCount ?? 0);
  const hasData = consolidated != null || bill != null;

  // A non-positive net total means the bill is fully covered: a negative total
  // is a credit balance (refunds/"saldo anterior" exceed the charges), so there
  // is nothing to pay this month.
  const nothingToPay = hasData && total <= 0;
  const hasCredit = hasData && total < 0;

  if (collapsed) {
    return (
      <Card
        surface="glass"
        className="w-12 shrink-0 flex flex-col items-center py-4 gap-3 self-start sticky top-4"
      >
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setCollapsed(false)}
          aria-label={t('components-credit-cards-detail-billpanel.expandPanel')}
        >
          <PanelRightOpen className="size-3.5" />
        </Button>
        <div
          className="writing-mode-vertical text-xs font-semibold text-muted-foreground rotate-180"
          style={{ writingMode: 'vertical-rl' }}
        >
          {hasData ? formatCurrency(total) : '—'}
        </div>
        {hasData && (
          <div
            className={cn(
              'h-2 w-2 rounded-full',
              isPaid || nothingToPay ? 'bg-income' : 'bg-warning',
            )}
          />
        )}
      </Card>
    );
  }

  return (
    <Card
      surface="glass"
      className="w-[380px] shrink-0 gap-0 py-0 flex flex-col self-start sticky top-4 max-h-[calc(100vh-6rem)] overflow-hidden"
      aria-label={t('components-credit-cards-detail-billpanel.panelAriaLabel')}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-glass-border">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onPrevMonth}
          aria-label={t('components-credit-cards-detail-billpanel.previousBill')}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <span className="text-sm font-semibold" aria-live="polite">
          {t('components-credit-cards-detail-billpanel.bill')}{' '}
          {getMonthName(month, locale, 'short')}/{year}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onNextMonth}
          aria-label={t('components-credit-cards-detail-billpanel.nextBill')}
        >
          <ChevronRight className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setCollapsed(true)}
          aria-label={t('components-credit-cards-detail-billpanel.collapsePanel')}
        >
          <PanelRightClose className="size-3.5" />
        </Button>
      </div>

      {/* Bill Summary */}
      <div className="p-4 text-center border-b border-glass-border">
        {isLoading ? (
          <div className="h-8 w-32 mx-auto bg-muted rounded animate-pulse" />
        ) : hasData ? (
          <>
            <AmountDisplay amount={total} size="lg" variant={hasCredit ? 'income' : 'neutral'} />
            <div className="mt-1">
              <BillStatus total={total} isPaid={isPaid} />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {bill?.dueDate
                ? t('components-credit-cards-detail-billpanel.billItemsWithDue', {
                    count: itemCount,
                    dueDate: new Date(`${bill.dueDate}T00:00:00`).toLocaleDateString(locale, {
                      day: '2-digit',
                      month: '2-digit',
                    }),
                  })
                : t('components-credit-cards-detail-billpanel.billItems', {
                    count: itemCount,
                  })}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('components-credit-cards-detail-billpanel.noBillInThis')}
          </p>
        )}
      </div>

      {/* Body: per-card breakdown (consolidated) or the card's own transactions */}
      <div className="flex-1 overflow-y-auto p-4 space-y-1">
        {consolidated ? (
          consolidated.breakdown.map((item) => (
            <div
              key={item.cardId}
              className="flex items-center justify-between py-1.5 border-b border-glass-border last:border-0 text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: item.color ?? cardColor(item.cardId) }}
                />
                <span className="font-medium truncate">{item.name}</span>
              </div>
              <AmountDisplay
                amount={item.total}
                size="sm"
                variant={item.total < 0 ? 'income' : 'neutral'}
              />
            </div>
          ))
        ) : bill && bill.transactions.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            {t('components-credit-cards-detail-billpanel.noTransactionsInThis')}
          </p>
        ) : (
          <>
            {(showAll ? (bill?.transactions ?? []) : (bill?.transactions ?? []).slice(0, 10)).map(
              (tx) => (
                <div
                  key={tx.id}
                  className="flex items-center justify-between py-1.5 border-b border-glass-border last:border-0 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">{tx.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(tx.date).toLocaleDateString(locale, { timeZone: 'UTC' })}
                      {tx.installmentNumber != null && tx.totalInstallments != null
                        ? ` · ${tx.installmentNumber}/${tx.totalInstallments}`
                        : ''}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <AmountDisplay
                      amount={Math.abs(safeParseFloat(tx.amount))}
                      size="sm"
                      variant="neutral"
                    />
                  </div>
                </div>
              ),
            )}
            {!showAll && (bill?.transactions.length ?? 0) > 10 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="w-full text-center text-xs text-primary py-2 hover:underline"
                aria-label={t('components-credit-cards-detail-billpanel.showMoreAriaLabel', {
                  count: (bill?.transactions.length ?? 0) - 10,
                })}
              >
                {t('components-credit-cards-detail-billpanel.showMore')}{' '}
                {(bill?.transactions.length ?? 0) - 10}{' '}
                {t('components-credit-cards-detail-billpanel.transactions')}
              </button>
            )}
          </>
        )}
      </div>

      {/* Pay button — hidden when there is nothing to pay (credit / zero) */}
      {hasData && !isPaid && itemCount > 0 && total > 0 && (
        <div className="p-4 border-t border-glass-border">
          <Button variant="brand" className="w-full" onClick={onPayBill}>
            {t('components-credit-cards-detail-billpanel.payBill')}
          </Button>
        </div>
      )}
    </Card>
  );
}
