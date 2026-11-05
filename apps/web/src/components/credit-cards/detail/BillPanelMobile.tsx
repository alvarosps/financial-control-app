'use client';

import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cardColor } from '@/lib/card-color';
import { getMonthName } from '@/lib/labels';
import { safeParseFloat } from '@/lib/parse';
import { cn } from '@/lib/utils';
import type { ConsolidatedPanel } from './BillPanel';
import { BillStatus } from './BillStatus';
import type { BillData } from './types';

type Props = {
  bill: BillData | null | undefined;
  consolidated?: ConsolidatedPanel | null;
  isLoading?: boolean;
  month: number;
  year: number;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onPayBill: () => void;
};

export function BillPanelMobile({
  bill,
  consolidated,
  isLoading,
  month,
  year,
  onPrevMonth,
  onNextMonth,
  onPayBill,
}: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Reset "show more" when month changes
  useEffect(() => {
    setShowAll(false);
  }, []);

  // Reflect the consolidated fatura (total + paid-state) when the card has
  // additional cards, mirroring the desktop panel.
  const total = consolidated ? consolidated.total : (bill?.total ?? 0);
  const isPaid = consolidated ? consolidated.isPaid : (bill?.isPaid ?? false);
  const itemCount = consolidated ? consolidated.transactionCount : (bill?.transactionCount ?? 0);
  const hasData = consolidated != null || bill != null;

  // A negative total is a credit balance where refunds/"saldo anterior" exceed
  // the charges; color the amount as income in that case.
  const hasCredit = hasData && total < 0;

  return (
    <Card surface="glass">
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onPrevMonth}
              aria-label={t('components-credit-cards-detail-billpanelmobile.previousBill')}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="text-sm font-semibold" aria-live="polite">
              {t('components-credit-cards-detail-billpanelmobile.bill')}{' '}
              {getMonthName(month, locale, 'short')}/{year}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onNextMonth}
              aria-label={t('components-credit-cards-detail-billpanelmobile.nextBill')}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
          {isLoading ? (
            <Skeleton className="h-4 w-24" />
          ) : (
            hasData && (
              <>
                <AmountDisplay
                  amount={total}
                  size="sm"
                  variant={hasCredit ? 'income' : 'neutral'}
                  className="font-bold"
                />
                <BillStatus total={total} isPaid={isPaid} />
              </>
            )
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="p-1 cursor-pointer bg-transparent border-0"
          aria-expanded={open}
          aria-label={
            open ? t('creditCards.bill.collapseDetails') : t('creditCards.bill.expandDetails')
          }
        >
          <ChevronDown
            className={cn(
              'size-4 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
      </div>

      {open && (
        <CardContent className="pt-0 space-y-2">
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
              {t('components-credit-cards-detail-billpanelmobile.noTransactionsInThis')}
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
                  aria-label={t('creditCards.bill.showMoreAria', {
                    count: (bill?.transactions.length ?? 0) - 10,
                  })}
                >
                  {t('creditCards.bill.showMore', {
                    count: (bill?.transactions.length ?? 0) - 10,
                  })}
                </button>
              )}
            </>
          )}
          {hasData && !isPaid && itemCount > 0 && total > 0 && (
            <Button className="w-full mt-2" onClick={onPayBill}>
              {t('components-credit-cards-detail-billpanelmobile.payBill')}
            </Button>
          )}
        </CardContent>
      )}
    </Card>
  );
}
