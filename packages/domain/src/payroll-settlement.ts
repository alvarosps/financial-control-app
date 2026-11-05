import { Money } from './money.ts';

export type PayrollDeductionInput = { installmentId: string; amountBrl: Money };

function assertBrl(value: Money, allowZero: boolean): void {
  if (
    value.currency !== 'BRL' ||
    !value.toDecimal().isFinite() ||
    value.isNegative() ||
    (!allowZero && value.isZero())
  ) {
    throw new Error('Payroll settlement requires valid BRL amounts');
  }
}

export function calculatePayrollSettlement(input: {
  grossBrl: Money;
  deductions: PayrollDeductionInput[];
  reportedNetBrl?: Money;
  acknowledgeDifference?: boolean;
}) {
  assertBrl(input.grossBrl, false);
  const ids = new Set<string>();
  for (const deduction of input.deductions) {
    assertBrl(deduction.amountBrl, false);
    if (!deduction.installmentId || ids.has(deduction.installmentId)) {
      throw new Error('A payroll installment can only be allocated once');
    }
    ids.add(deduction.installmentId);
  }
  const deductionsBrl = Money.sum(input.deductions.map((item) => item.amountBrl));
  if (deductionsBrl.isGreaterThan(input.grossBrl)) {
    throw new Error('Payroll deductions exceed income');
  }
  const expectedNetBrl = input.grossBrl.subtract(deductionsBrl);
  const netBrl = input.reportedNetBrl ?? expectedNetBrl;
  assertBrl(netBrl, true);
  const differenceBrl = netBrl.subtract(expectedNetBrl);
  if (!differenceBrl.isZero() && input.acknowledgeDifference !== true) {
    throw new Error('Reported net income differs; explicit review is required');
  }
  return { grossBrl: input.grossBrl, deductionsBrl, expectedNetBrl, netBrl, differenceBrl };
}
