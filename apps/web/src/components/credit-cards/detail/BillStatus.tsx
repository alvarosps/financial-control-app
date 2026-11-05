'use client';

import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/shared/StatusBadge';

type Props = {
  /** Net bill total (signed). A value <= 0 means a credit / nothing to pay. */
  total: number;
  isPaid: boolean;
};

/**
 * Single source of truth for a bill's status chip. A non-positive net total is a
 * credit balance (refunds/"saldo anterior" cover the charges), so it must read
 * "nothing to pay" rather than the misleading "pending" — even though `isPaid`
 * stays false (no charge was actually paid). Used by the detail panels, the
 * detail header card, and the credit-card list tile so all surfaces agree.
 */
export function BillStatus({ total, isPaid }: Props) {
  const t = useTranslations();
  if (isPaid) return <StatusBadge status="paid" />;
  if (total <= 0) {
    return (
      <span className="text-xs font-medium text-income">{t('creditCards.bill.nothingToPay')}</span>
    );
  }
  return <StatusBadge status="pending" />;
}
