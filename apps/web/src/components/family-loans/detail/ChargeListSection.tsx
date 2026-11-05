'use client';

import { useTranslations } from 'next-intl';
import { CompositionAccordion } from '@/components/shared/CompositionAccordion';
import { ItemRow } from '@/components/shared/ItemRow';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { safeParseFloat } from '@/lib/parse';
import { type FamilyLoanLedger, MonthlyPaymentSummary } from './MonthlyPaymentSummary';

export type ChargeItem = {
  id: string;
  description: string;
  amount: string;
  installmentNumber?: number | null;
  totalInstallments?: number | null;
  scheduledTransactionId?: string | null;
  domainType?: string | null;
  isPaid: boolean;
};

export type BorrowedCard = {
  id: string;
  creditCardAccountId: string;
  description?: string | null;
};

type Props = {
  chargeTotal: number;
  discountTotal: number;
  instTotal: number;
  fixedTotal: number;
  oneTimeChargeTotal: number;
  cardTotal: number;
  pctInst: number;
  pctCard: number;
  pctFixed: number;
  pctOneTimeCharge: number;
  sortedInstallments: ChargeItem[];
  filteredInstallments: ChargeItem[];
  installmentSearch: string;
  onInstallmentSearchChange: (v: string) => void;
  cards: BorrowedCard[];
  cardNameMap: Map<string, string>;
  borrowedCardBreakdown: Array<{ creditCardAccountId: string; total: number }>;
  fixedChargeItems: ChargeItem[];
  expenseItems: ChargeItem[];
  sortedDiscounts: ChargeItem[];
  ledger?: FamilyLoanLedger;
  month: number;
  year: number;
  onDeleteItem: (id: string, name: string) => void;
  onEditItem: (item: ChargeItem) => void;
};

export function ChargeListSection({
  chargeTotal,
  discountTotal,
  instTotal,
  fixedTotal,
  oneTimeChargeTotal,
  cardTotal,
  pctInst,
  pctCard,
  pctFixed,
  pctOneTimeCharge,
  sortedInstallments,
  filteredInstallments,
  installmentSearch,
  onInstallmentSearchChange,
  cards,
  cardNameMap,
  borrowedCardBreakdown,
  fixedChargeItems,
  expenseItems,
  sortedDiscounts,
  ledger,
  month,
  year,
  onDeleteItem,
  onEditItem,
}: Props) {
  const t = useTranslations();
  return (
    <Card>
      <CardContent className="pt-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {t('components-family-loans-detail-chargelistsection.chargeComposition')}
          </h2>
          <span className="text-base font-bold text-income">
            {formatCurrency(chargeTotal - discountTotal)}
          </span>
        </div>

        {/* Proportion bar */}
        {chargeTotal > 0 && (
          <>
            <div className="h-2 flex rounded-full overflow-hidden">
              {pctInst > 0 && (
                <div style={{ width: `${pctInst}%` }} className="bg-brand-installment" />
              )}
              {pctCard > 0 && <div style={{ width: `${pctCard}%` }} className="bg-brand-fixed" />}
              {pctFixed > 0 && <div style={{ width: `${pctFixed}%` }} className="bg-warning" />}
              {pctOneTimeCharge > 0 && (
                <div style={{ width: `${pctOneTimeCharge}%` }} className="bg-income" />
              )}
            </div>
            <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
              {pctInst > 0 && (
                <div className="flex items-center gap-1">
                  <div className="h-2 w-2 rounded-sm bg-brand-installment" />
                  {t('components-family-loans-detail-chargelistsection.installmentsPct', {
                    pct: pctInst.toFixed(1),
                  })}
                </div>
              )}
              {pctCard > 0 && (
                <div className="flex items-center gap-1">
                  <div className="h-2 w-2 rounded-sm bg-brand-fixed" />
                  {t('components-family-loans-detail-chargelistsection.cards')} {pctCard.toFixed(1)}
                  %
                </div>
              )}
              {pctFixed > 0 && (
                <div className="flex items-center gap-1">
                  <div className="h-2 w-2 rounded-sm bg-warning" />
                  {t('components-family-loans-detail-chargelistsection.fixedPct', {
                    pct: pctFixed.toFixed(1),
                  })}
                </div>
              )}
              {pctOneTimeCharge > 0 && (
                <div className="flex items-center gap-1">
                  <div className="h-2 w-2 rounded-sm bg-income" />
                  {t('components-family-loans-detail-chargelistsection.oneTimeChargesPct', {
                    pct: pctOneTimeCharge.toFixed(1),
                  })}
                </div>
              )}
            </div>
          </>
        )}

        <div className={ledger ? 'grid gap-4 lg:grid-cols-3' : undefined}>
          {/* Accordions */}
          <div className="space-y-2 lg:col-span-2">
            {/* Parcelas */}
            <CompositionAccordion
              title={t('components-family-loans-detail-chargelistsection.installments')}
              count={sortedInstallments.length}
              total={instTotal}
              color="purple"
              defaultOpen={sortedInstallments.length <= 10}
            >
              {sortedInstallments.length > 5 && (
                <input
                  type="text"
                  value={installmentSearch}
                  onChange={(e) => onInstallmentSearchChange(e.target.value)}
                  placeholder={t(
                    'components-family-loans-detail-chargelistsection.searchInstallment',
                  )}
                  aria-label={t(
                    'components-family-loans-detail-chargelistsection.searchInstallments',
                  )}
                  className="mb-2 h-7 w-full rounded-md border border-glass-border bg-glass-bg px-2.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              )}
              {filteredInstallments.map((item) => (
                <ItemRow
                  key={item.id}
                  name={item.description}
                  amount={safeParseFloat(item.amount)}
                  progress={
                    item.totalInstallments && item.installmentNumber
                      ? { current: item.installmentNumber, total: item.totalInstallments }
                      : null
                  }
                  statusLabel={
                    item.isPaid
                      ? t('components-family-loans-detail-chargelistsection.settledHistory')
                      : undefined
                  }
                  onEdit={
                    !item.isPaid && item.scheduledTransactionId ? () => onEditItem(item) : undefined
                  }
                  onDelete={
                    !item.isPaid && item.scheduledTransactionId
                      ? () => onDeleteItem(item.scheduledTransactionId ?? '', item.description)
                      : undefined
                  }
                />
              ))}
              {filteredInstallments.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">
                  {t('components-family-loans-detail-chargelistsection.noInstallmentsFound')}
                </p>
              )}
            </CompositionAccordion>

            {/* Cartões Emprestados */}
            <CompositionAccordion
              title={t('components-family-loans-detail-chargelistsection.borrowedCards')}
              count={cards.length}
              total={cardTotal}
              color="cyan"
              defaultOpen
            >
              {cards.map((card) => {
                const cardName =
                  cardNameMap.get(card.creditCardAccountId) ??
                  card.description ??
                  t('familyLoans.unnamedCard');
                const cardAmount =
                  borrowedCardBreakdown.find(
                    (b) => b.creditCardAccountId === card.creditCardAccountId,
                  )?.total ?? 0;
                return <ItemRow key={card.id} name={cardName} amount={cardAmount} />;
              })}
            </CompositionAccordion>

            {/* Cobranças Fixas */}
            <CompositionAccordion
              title={t('components-family-loans-detail-chargelistsection.fixedCharges')}
              count={fixedChargeItems.length}
              total={fixedTotal}
              color="amber"
              defaultOpen
            >
              {fixedChargeItems.map((item) => (
                <ItemRow
                  key={item.id}
                  name={item.description}
                  amount={safeParseFloat(item.amount)}
                  statusLabel={
                    item.isPaid
                      ? t('components-family-loans-detail-chargelistsection.settledHistory')
                      : undefined
                  }
                  onDelete={
                    !item.isPaid && item.scheduledTransactionId
                      ? () => onDeleteItem(item.scheduledTransactionId ?? '', item.description)
                      : undefined
                  }
                />
              ))}
            </CompositionAccordion>

            {/* Gastos */}
            <CompositionAccordion
              title={t('components-family-loans-detail-chargelistsection.expenses')}
              count={expenseItems.length}
              total={oneTimeChargeTotal}
              color="green"
              defaultOpen
            >
              {expenseItems.map((item) => (
                <ItemRow
                  key={item.id}
                  name={item.description}
                  amount={safeParseFloat(item.amount)}
                  statusLabel={
                    item.isPaid
                      ? t('components-family-loans-detail-chargelistsection.settledHistory')
                      : undefined
                  }
                  onEdit={
                    !item.isPaid && item.scheduledTransactionId ? () => onEditItem(item) : undefined
                  }
                  onDelete={
                    !item.isPaid && item.scheduledTransactionId
                      ? () => onDeleteItem(item.scheduledTransactionId ?? '', item.description)
                      : undefined
                  }
                />
              ))}
            </CompositionAccordion>

            {/* Descontos */}
            <CompositionAccordion
              title={t('components-family-loans-detail-chargelistsection.discounts')}
              count={sortedDiscounts.length}
              total={discountTotal}
              color="red"
              defaultOpen
            >
              {sortedDiscounts.map((item) => (
                <ItemRow
                  key={item.id}
                  name={item.description}
                  amount={safeParseFloat(item.amount)}
                  variant="expense"
                  progress={
                    item.totalInstallments && item.installmentNumber
                      ? { current: item.installmentNumber, total: item.totalInstallments }
                      : null
                  }
                  statusLabel={
                    item.isPaid
                      ? t('components-family-loans-detail-chargelistsection.settledHistory')
                      : undefined
                  }
                  onEdit={
                    !item.isPaid && item.scheduledTransactionId ? () => onEditItem(item) : undefined
                  }
                  onDelete={
                    !item.isPaid && item.scheduledTransactionId
                      ? () => onDeleteItem(item.scheduledTransactionId ?? '', item.description)
                      : undefined
                  }
                />
              ))}
            </CompositionAccordion>
          </div>

          {ledger && <MonthlyPaymentSummary ledger={ledger} month={month} year={year} />}
        </div>
      </CardContent>
    </Card>
  );
}
