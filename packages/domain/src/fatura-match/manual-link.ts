import Decimal from 'decimal.js';
import type { ExpectedItem, ParsedItem } from './types.ts';

type ManualLinkInput = {
  parsed: ParsedItem;
  expected: ExpectedItem;
  targetCardAccountId: string | null;
};

function hasNoInstallment(parsed: ParsedItem): boolean {
  return parsed.installmentCurrent === null && parsed.installmentTotal === null;
}

export function canManuallyLinkFaturaItem({
  parsed,
  expected,
  targetCardAccountId,
}: ManualLinkInput): boolean {
  const expectedIsRefund = expected.domainType === 'credit_card_refund';
  if (
    parsed.isRefund !== expectedIsRefund ||
    (targetCardAccountId !== null && targetCardAccountId !== expected.cardAccountId) ||
    (expected.isPaid === true &&
      new Decimal(parsed.amountBRL).abs().toFixed(2) !== expected.amountBRL)
  ) {
    return false;
  }

  if (
    expected.domainType === 'credit_card_expense' ||
    expected.domainType === 'credit_card_refund'
  ) {
    return hasNoInstallment(parsed);
  }

  if (expected.domainType === 'credit_card_fixed_charge') {
    return expected.scheduleId !== null && hasNoInstallment(parsed);
  }

  if (expected.domainType !== 'credit_card_installment' || expected.scheduleId === null) {
    return false;
  }

  return (
    (parsed.installmentCurrent === null ||
      parsed.installmentCurrent === expected.installmentNumber) &&
    (parsed.installmentTotal === null || parsed.installmentTotal === expected.totalInstallments)
  );
}
