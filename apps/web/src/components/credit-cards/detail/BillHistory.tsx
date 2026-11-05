'use client';

import { useLocale, useTranslations } from 'next-intl';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { Card, CardContent } from '@/components/ui/card';
import { getMonthName } from '@/lib/labels';
import { trpc } from '@/lib/trpc/client';

type Props = {
  cardId: string;
  onSelectMonth: (month: number, year: number) => void;
};

export function BillHistory({ cardId, onSelectMonth }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const { data: billHistory, isLoading } = trpc.creditCard.getBillHistory.useQuery({
    cardAccountId: cardId,
  });

  const bills = billHistory?.filter((b) => b.transactionCount > 0) ?? [];

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {t('components-credit-cards-detail-billhistory.billHistory')}
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-elevated/95 backdrop-blur-sm">
              <tr className="border-b">
                <th scope="col" className="text-left py-2 pr-4 font-medium">
                  {t('components-credit-cards-detail-billhistory.period')}
                </th>
                <th scope="col" className="text-right py-2 px-2 font-medium">
                  {t('components-credit-cards-detail-billhistory.total')}
                </th>
                <th scope="col" className="text-center py-2 px-2 font-medium">
                  {t('components-credit-cards-detail-billhistory.status')}
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={3} className="text-center py-4 text-muted-foreground text-xs">
                    {t('components-credit-cards-detail-billhistory.loading')}
                  </td>
                </tr>
              )}
              {!isLoading && bills.length === 0 && (
                <tr>
                  <td colSpan={3} className="text-center py-4 text-muted-foreground text-xs">
                    {t('components-credit-cards-detail-billhistory.noBillsInThe')}
                  </td>
                </tr>
              )}
              {bills.map((b) => (
                <tr
                  key={`${b.month}-${b.year}`}
                  className="border-b last:border-0 cursor-pointer hover:bg-glass-hover-bg transition-colors"
                  onClick={() => onSelectMonth(b.month, b.year)}
                >
                  <td className="py-2 pr-4 font-medium">
                    {getMonthName(b.month, locale)} {b.year}
                  </td>
                  <td className="text-right py-2 px-2">
                    <AmountDisplay
                      amount={b.total}
                      size="sm"
                      variant={b.total < 0 ? 'income' : 'neutral'}
                    />
                  </td>
                  <td className="text-center py-2 px-2">
                    <StatusBadge status={b.isPaid ? 'paid' : 'pending'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
