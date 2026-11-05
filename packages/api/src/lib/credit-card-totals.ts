import { Money } from '@fc/domain';

export function computeCardBillTotals<
  T extends { amount: string; isPaid: boolean; domainType: string | null },
>(items: T[], currency: string) {
  const isRefund = (t: { domainType: string | null }) => t.domainType === 'credit_card_refund';
  const charges = items.filter((t) => !isRefund(t));
  const refunds = items.filter(isRefund);
  const chargesMoney = Money.sum(
    charges.map((t) => Money.fromString(t.amount, currency)),
    currency,
  );
  const refundsMoney = Money.sum(
    refunds.map((t) => Money.fromString(t.amount, currency)),
    currency,
  );
  const paidChargesMoney = Money.sum(
    charges.filter((t) => t.isPaid).map((t) => Money.fromString(t.amount, currency)),
    currency,
  );
  const totalMoney = chargesMoney.subtract(refundsMoney);
  const unpaidTotalMoney = totalMoney.subtract(paidChargesMoney);
  // A bill is "paid" once every CHARGE is paid; refunds are credits, not payable.
  const isPaid = charges.length > 0 && charges.every((t) => t.isPaid);
  return {
    totalMoney,
    paidTotalMoney: paidChargesMoney,
    unpaidTotalMoney,
    // Gross charges / refunds, exposed so pay-bill can tell a legitimate
    // credit balance (refunds > charges) apart from real data corruption.
    chargesTotalMoney: chargesMoney,
    refundsTotalMoney: refundsMoney,
    isPaid,
    charges,
    refunds,
  };
}
