import { describe, expect, it } from 'vitest';
import { Money } from './money.ts';
import { calculatePayrollSettlement } from './payroll-settlement.ts';

const brl = (value: string) => Money.fromString(value, 'BRL');

describe('calculatePayrollSettlement', () => {
  it('preserves gross income and expenses while payroll only reduces the deposit', () => {
    const result = calculatePayrollSettlement({
      grossBrl: brl('10000'),
      deductions: [{ installmentId: 'payroll', amountBrl: brl('1000') }],
    });
    expect(result.grossBrl.toDbString()).toBe('10000.00');
    expect(result.deductionsBrl.toDbString()).toBe('1000.00');
    expect(result.netBrl.toDbString()).toBe('9000.00');
    expect(result.netBrl.subtract(brl('500')).toDbString()).toBe('8500.00');
  });

  it('allocates two deductions only to the selected income occurrence and is repeatable after undo', () => {
    const input = {
      grossBrl: brl('6000'),
      deductions: [
        { installmentId: 'a', amountBrl: brl('600.25') },
        { installmentId: 'b', amountBrl: brl('399.75') },
      ],
    };
    const first = calculatePayrollSettlement(input);
    const second = calculatePayrollSettlement({ grossBrl: brl('4000'), deductions: [] });
    expect(first.netBrl.add(second.netBrl).toDbString()).toBe('9000.00');
    expect(calculatePayrollSettlement(input).netBrl.equals(first.netBrl)).toBe(true);
    expect(input.grossBrl.toDbString()).toBe('6000.00');
    expect(input.deductions).toHaveLength(2);
  });

  it('permits a zero deposit but rejects deductions exceeding income', () => {
    const input = {
      grossBrl: brl('1000'),
      deductions: [{ installmentId: 'a', amountBrl: brl('1000') }],
    };
    expect(calculatePayrollSettlement(input).netBrl.toDbString()).toBe('0.00');
    expect(() => calculatePayrollSettlement({ ...input, grossBrl: brl('999.99') })).toThrow();
  });

  it('rejects repeated installments, negative values and foreign amounts before allocation', () => {
    const deduction = { installmentId: 'a', amountBrl: brl('100') };
    expect(() =>
      calculatePayrollSettlement({ grossBrl: brl('1000'), deductions: [deduction, deduction] }),
    ).toThrow();
    expect(() =>
      calculatePayrollSettlement({
        grossBrl: brl('1000'),
        deductions: [{ ...deduction, amountBrl: brl('-1') }],
      }),
    ).toThrow();
    expect(() =>
      calculatePayrollSettlement({ grossBrl: Money.fromString('1000', 'USD'), deductions: [] }),
    ).toThrow();
  });

  it('requires explicit review of a reported net difference without rewriting gross or deductions', () => {
    const input = {
      grossBrl: brl('10000'),
      deductions: [{ installmentId: 'a', amountBrl: brl('1000') }],
      reportedNetBrl: brl('8900'),
    };
    expect(() => calculatePayrollSettlement(input)).toThrow();
    const result = calculatePayrollSettlement({ ...input, acknowledgeDifference: true });
    expect(result.netBrl.toDbString()).toBe('8900.00');
    expect(result.expectedNetBrl.toDbString()).toBe('9000.00');
    expect(result.differenceBrl.toDbString()).toBe('-100.00');
    expect(result.grossBrl.toDbString()).toBe('10000.00');
  });
});
