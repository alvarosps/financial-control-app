'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { FileUp, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { BillStatus } from '@/components/credit-cards/detail/BillStatus';
import {
  PurchaseCoverage,
  type PurchaseCoverageData,
} from '@/components/purchases/PurchaseCoverage';
import { CreditCardVisual } from '@/components/shared/CreditCardVisual';
import { Button } from '@/components/ui/button';
import { cardColor } from '@/lib/card-color';
import { formatCurrency } from '@/lib/format';
import { getMonthName } from '@/lib/labels';

export type CardSummary = inferRouterOutputs<AppRouter>['creditCard']['getBillSummary'][number];

type Props = {
  card: CardSummary;
  creditLimit: number;
  onPay: () => void;
  onImport: () => void;
  actionsDisabled?: boolean;
  coverage?: PurchaseCoverageData;
};

export function CreditCardListItem({
  card,
  creditLimit,
  onPay,
  onImport,
  actionsDisabled,
  coverage,
}: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const bill = card.currentBill;
  const canPay = bill.total > 0 && bill.unpaidTotal > 0 && !bill.isPaid;
  const nextTotal = Math.max(0, card.nextBillPreview.total);
  return (
    <article className="flex min-w-0 flex-col">
      <Link
        id={`credit-card-${card.cardId}`}
        href={`/credit-cards/${card.cardId}`}
        className="block rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-4 motion-safe:transition-transform motion-safe:duration-200 motion-safe:hover:-translate-y-0.5"
      >
        <CreditCardVisual
          name={card.cardName}
          color={card.color ?? cardColor(card.cardId)}
          dueDay={bill.dueDay ?? undefined}
          dueLabel={t('creditCards.dueDayShort')}
          status={<BillStatus total={bill.total} isPaid={bill.isPaid} />}
          billMonthLabel={`${t('creditCards.billMonth')}: ${getMonthName(bill.month, locale)} ${bill.year}`}
          limitPct={creditLimit > 0 ? (Math.max(0, bill.total) / creditLimit) * 100 : undefined}
          limitLabel={t('creditCards.limitUsedShort')}
          bill={
            <span className="text-2xl font-bold font-numeric tabular-nums text-white">
              {formatCurrency(bill.total)}
            </span>
          }
        />
      </Link>
      {nextTotal > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('creditCards.nextBillShort')}: {formatCurrency(nextTotal)}
        </p>
      )}
      <div className="mt-auto flex flex-wrap gap-2 pt-3">
        {canPay && (
          <Button
            variant="brand"
            size="sm"
            className="min-h-9 flex-1"
            onClick={onPay}
            disabled={actionsDisabled}
            aria-label={t('creditCards.actions.payBillFor', { card: card.cardName })}
          >
            <Wallet className="size-3.5" aria-hidden />
            {t('creditCards.actions.payBill')}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="min-h-9 flex-1"
          onClick={onImport}
          disabled={actionsDisabled}
          aria-label={t('creditCards.actions.updateBillFor', { card: card.cardName })}
        >
          <FileUp className="size-3.5" aria-hidden />
          {t('creditCards.actions.updateBill')}
        </Button>
      </div>
      {coverage && <PurchaseCoverage coverage={coverage} compact />}
    </article>
  );
}
