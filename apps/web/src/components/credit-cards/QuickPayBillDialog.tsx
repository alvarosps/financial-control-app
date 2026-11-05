'use client';

import { useTranslations } from 'next-intl';
import { PayBillDialog } from '@/components/credit-cards/detail/dialogs/PayBillDialog';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';

export type BillPaymentTarget = {
  cardId: string;
  cardName: string;
  month: number;
  year: number;
  dueDate: string | null;
};

type Props = {
  target: BillPaymentTarget;
  onOpenChange: (open: boolean) => void;
  paymentAccounts: { id: string; name: string }[];
  accountsLoading: boolean;
  accountsError?: string;
  onRetryAccounts: () => Promise<unknown>;
  finalFocus?: () => HTMLElement | null;
};

export function QuickPayBillDialog({
  target,
  onOpenChange,
  paymentAccounts,
  accountsLoading,
  accountsError,
  onRetryAccounts,
  finalFocus,
}: Props) {
  const t = useTranslations();
  const bill = trpc.creditCard.getConsolidatedBill.useQuery(
    { cardAccountId: target.cardId, month: target.month, year: target.year },
    { staleTime: 0, refetchOnMount: 'always' },
  );
  return (
    <PayBillDialog
      open
      onOpenChange={onOpenChange}
      cardId={target.cardId}
      cardName={target.cardName}
      month={target.month}
      year={target.year}
      dueDate={target.dueDate}
      billTotal={bill.data?.total ?? 0}
      paymentAmount={bill.data?.isPaid ? 0 : (bill.data?.unpaidTotal ?? 0)}
      breakdown={bill.data?.breakdown}
      paymentAccounts={paymentAccounts}
      isLoading={bill.isPending || bill.isFetching || accountsLoading}
      loadError={bill.error ? resolveTRPCError(bill.error, t) : accountsError}
      onRetry={() => {
        void bill.refetch();
        void onRetryAccounts();
      }}
      onPaymentError={() => bill.refetch()}
      finalFocus={finalFocus}
    />
  );
}
