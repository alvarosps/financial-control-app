// src/components/credit-cards/detail/BillComposition.tsx
'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { CompositionAccordion } from '@/components/shared/CompositionAccordion';
import { ItemRow } from '@/components/shared/ItemRow';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { getMonthName } from '@/lib/labels';
import { safeParseFloat } from '@/lib/parse';
import { InstallmentList } from './InstallmentList';

type ScheduledItem = {
  id: string;
  scheduledTransactionId?: string | null;
  description: string;
  amount: string | number;
  domainType: string | null;
  isActive: boolean;
  totalOccurrences: number | null;
  startingOccurrence: number | null;
  categoryId: string | null;
  isFixedCharge: boolean | null;
  canEdit?: boolean;
  startDate?: string | Date | null;
};

type Category = { id: string; name: string };

type Props = {
  installments: ScheduledItem[];
  fixedCharges: ScheduledItem[];
  monthlyExpenses: ScheduledItem[];
  refunds: { id: string; description: string; amount: string }[];
  categories: Category[];
  month: number;
  year: number;
  onEditItem: (id: string) => void;
  onDeleteItem: (id: string, name: string, isScheduled: boolean) => void;
  onDeleteRefund: (id: string, name: string) => void;
};

export function BillComposition({
  installments,
  fixedCharges,
  monthlyExpenses,
  refunds,
  categories,
  month,
  year,
  onEditItem,
  onDeleteItem,
  onDeleteRefund,
}: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const categoryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of categories ?? []) {
      map.set(cat.id, cat.name);
    }
    return map;
  }, [categories]);

  const instTotal = installments.reduce((s, i) => s + Math.abs(safeParseFloat(i.amount)), 0);
  const fixedTotal = fixedCharges.reduce((s, i) => s + Math.abs(safeParseFloat(i.amount)), 0);
  const expenseTotal = monthlyExpenses.reduce((s, i) => s + Math.abs(safeParseFloat(i.amount)), 0);
  const refundTotal = refunds.reduce((s, i) => s + Math.abs(safeParseFloat(i.amount)), 0);
  const grandTotal = instTotal + fixedTotal + expenseTotal - refundTotal;
  const total = instTotal + fixedTotal + expenseTotal;

  // Proportion bar percentages
  const pctInst = total > 0 ? (instTotal / total) * 100 : 0;
  const pctFixed = total > 0 ? (fixedTotal / total) * 100 : 0;
  const pctExpense = total > 0 ? (expenseTotal / total) * 100 : 0;

  return (
    <Card>
      <CardContent className="pt-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {t('components-credit-cards-detail-billcomposition.billComposition')}{' '}
            {getMonthName(month, locale)} {year}
          </h2>
          <span className="text-base font-bold">{formatCurrency(grandTotal)}</span>
        </div>

        {/* Proportion bar */}
        {total > 0 && (
          <>
            <div className="h-2 flex rounded-full overflow-hidden">
              {pctInst > 0 && (
                <div style={{ width: `${pctInst}%` }} className="bg-brand-installment" />
              )}
              {pctFixed > 0 && <div style={{ width: `${pctFixed}%` }} className="bg-brand-fixed" />}
              {pctExpense > 0 && <div style={{ width: `${pctExpense}%` }} className="bg-warning" />}
            </div>
            <div className="flex gap-4 text-xs text-muted-foreground">
              {pctInst > 0 && (
                <div className="flex items-center gap-1">
                  <div className="h-2 w-2 rounded-sm bg-brand-installment" />
                  {t('bill.composition.installments')} {pctInst.toFixed(1)}%
                </div>
              )}
              {pctFixed > 0 && (
                <div className="flex items-center gap-1">
                  <div className="h-2 w-2 rounded-sm bg-brand-fixed" />
                  {t('bill.composition.fixed')} {pctFixed.toFixed(1)}%
                </div>
              )}
              {pctExpense > 0 && (
                <div className="flex items-center gap-1">
                  <div className="h-2 w-2 rounded-sm bg-warning" />
                  {t('bill.composition.expenses')} {pctExpense.toFixed(1)}%
                </div>
              )}
            </div>
          </>
        )}

        {/* Accordions */}
        <div className="space-y-2">
          <CompositionAccordion
            title={t('bill.composition.installments')}
            count={installments.length}
            total={instTotal}
            color="purple"
            defaultOpen={installments.length <= 10}
          >
            <InstallmentList
              items={installments}
              categories={categories}
              onEdit={onEditItem}
              onDelete={onDeleteItem}
            />
          </CompositionAccordion>

          <CompositionAccordion
            title={t('bill.composition.fixedCharges')}
            count={fixedCharges.length}
            total={fixedTotal}
            color="cyan"
            defaultOpen
          >
            {fixedCharges.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-2">
                {t('components-credit-cards-detail-billcomposition.noFixedCharges')}
              </p>
            ) : (
              fixedCharges.map((charge) => (
                <ItemRow
                  key={charge.id}
                  name={charge.description}
                  amount={Math.abs(safeParseFloat(charge.amount))}
                  categoryName={
                    charge.categoryId ? (categoryMap.get(charge.categoryId) ?? null) : null
                  }
                  onEdit={
                    charge.canEdit !== false
                      ? () => onEditItem(charge.scheduledTransactionId ?? charge.id)
                      : undefined
                  }
                  onDelete={() =>
                    onDeleteItem(
                      charge.scheduledTransactionId ?? charge.id,
                      charge.description,
                      !!charge.scheduledTransactionId,
                    )
                  }
                />
              ))
            )}
          </CompositionAccordion>

          {/* Empty sections as chips */}
          {monthlyExpenses.length === 0 && refunds.length === 0 ? (
            <div className="flex gap-2">
              <div className="flex-1 flex items-center justify-between rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-xs">
                <span className="font-semibold text-warning">
                  {t('bill.composition.expenses')} (0)
                </span>
                <span>{formatCurrency(0)}</span>
              </div>
              <div className="flex-1 flex items-center justify-between rounded-lg border border-income/20 bg-income/5 px-3 py-2 text-xs">
                <span className="font-semibold text-income">
                  {t('bill.composition.refunds')} (0)
                </span>
                <span>-{formatCurrency(0)}</span>
              </div>
            </div>
          ) : (
            <>
              {monthlyExpenses.length > 0 && (
                <CompositionAccordion
                  title={t('bill.composition.monthlyExpenses')}
                  count={monthlyExpenses.length}
                  total={expenseTotal}
                  color="amber"
                  defaultOpen
                >
                  {monthlyExpenses.map((exp) => (
                    <ItemRow
                      key={exp.id}
                      name={exp.description}
                      amount={Math.abs(safeParseFloat(exp.amount))}
                      categoryName={
                        exp.categoryId ? (categoryMap.get(exp.categoryId) ?? null) : null
                      }
                      onEdit={
                        exp.canEdit !== false
                          ? () => onEditItem(exp.scheduledTransactionId ?? exp.id)
                          : undefined
                      }
                      onDelete={() =>
                        onDeleteItem(
                          exp.scheduledTransactionId ?? exp.id,
                          exp.description,
                          !!exp.scheduledTransactionId,
                        )
                      }
                    />
                  ))}
                </CompositionAccordion>
              )}
              {refunds.length > 0 && (
                <CompositionAccordion
                  title={t('bill.composition.refunds')}
                  count={refunds.length}
                  total={refundTotal}
                  color="green"
                  defaultOpen
                >
                  {refunds.map((ref) => (
                    <ItemRow
                      key={ref.id}
                      name={ref.description}
                      amount={Math.abs(safeParseFloat(ref.amount))}
                      variant="income"
                      onEdit={() => onEditItem(ref.id)}
                      onDelete={() => onDeleteRefund(ref.id, ref.description)}
                    />
                  ))}
                </CompositionAccordion>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
