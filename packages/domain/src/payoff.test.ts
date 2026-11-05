import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { Money } from './money.ts';
import {
  calculateOutstandingBalance,
  calculatePayoffSavings,
  PayoffCalculationType,
} from './payoff.ts';

const BRL = 'BRL';
const money = (s: string) => Money.fromString(s, BRL);
const rate = (s: string) => Money.fromDecimal(new Decimal(s), BRL);

describe('calculateOutstandingBalance', () => {
  it('consignado mensal: PV less than total remaining', () => {
    const result = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('1500'),
      remainingInstallments: 33,
      monthlyInterestRate: rate('0.0199'),
    });
    expect(result.toNumber()).toBeLessThan(1500 * 33);
    expect(result.isPositive()).toBe(true);
  });

  it('pessoal diario: ordering vs consignado depende de daysUntilNextPayment', () => {
    const base = {
      monthlyPayment: money('800'),
      remainingInstallments: 20,
      monthlyInterestRate: rate('0.025'),
    };
    const consignado = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      ...base,
    });
    const em15dias = calculateOutstandingBalance({
      type: PayoffCalculationType.PESSOAL_DIARIO,
      ...base,
      daysUntilNextPayment: 15,
    });
    const em60dias = calculateOutstandingBalance({
      type: PayoffCalculationType.PESSOAL_DIARIO,
      ...base,
      daysUntilNextPayment: 60,
    });
    expect(em15dias.isGreaterThan(consignado)).toBe(true);
    expect(em60dias.isLessThan(consignado)).toBe(true);
    expect(em60dias.isPositive()).toBe(true);
  });

  it('pessoal diario com d=30 equals consignado PV (uma parcela = um periodo de 30 dias)', () => {
    const consignado = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('800'),
      remainingInstallments: 20,
      monthlyInterestRate: rate('0.025'),
    });
    const pessoal = calculateOutstandingBalance({
      type: PayoffCalculationType.PESSOAL_DIARIO,
      monthlyPayment: money('800'),
      remainingInstallments: 20,
      monthlyInterestRate: rate('0.025'),
      daysUntilNextPayment: 30,
    });
    expect(consignado.toDbString()).toBe('12471.33');
    expect(pessoal.toDbString()).toBe(consignado.toDbString());
  });

  it('cdc veiculos: PV calculation', () => {
    const result = calculateOutstandingBalance({
      type: PayoffCalculationType.CDC_VEICULOS,
      monthlyPayment: money('2000'),
      remainingInstallments: 36,
      monthlyInterestRate: rate('0.0159'),
    });
    expect(result.toNumber()).toBeLessThan(2000 * 36);
    expect(result.isPositive()).toBe(true);
  });

  it('sem desconto: full remaining amount', () => {
    const result = calculateOutstandingBalance({
      type: PayoffCalculationType.SEM_DESCONTO,
      monthlyPayment: money('500'),
      remainingInstallments: 10,
      monthlyInterestRate: rate('0'),
    });
    expect(result.toDbString()).toBe('5000.00');
  });

  it('returns 0 for 0 remaining', () => {
    const result = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('1500'),
      remainingInstallments: 0,
      monthlyInterestRate: rate('0.02'),
    });
    expect(result.isZero()).toBe(true);
  });
});

describe('calculatePayoffSavings', () => {
  it('calculates savings amount and percent', () => {
    const payoff = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('1500'),
      remainingInstallments: 33,
      monthlyInterestRate: rate('0.0199'),
    });
    const { savings, savingsPercent } = calculatePayoffSavings(money('1500'), 33, payoff);
    expect(savings.isPositive()).toBe(true);
    expect(savingsPercent).toBeGreaterThan(0);
    expect(savingsPercent).toBeLessThan(100);
  });

  it('returns 0 savings for sem desconto', () => {
    const { savings } = calculatePayoffSavings(money('500'), 10, money('5000'));
    expect(savings.isZero()).toBe(true);
  });
});
