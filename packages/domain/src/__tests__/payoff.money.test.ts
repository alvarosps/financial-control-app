import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { Money } from '../money.ts';
import {
  calculateOutstandingBalance,
  calculatePayoffSavings,
  PayoffCalculationType,
} from '../payoff.ts';
import {
  ORACLE_CONSIGNADO_R1_N12,
  ORACLE_CONSIGNADO_R1_N36,
  ORACLE_CONSIGNADO_R1_N360,
  ORACLE_CONSIGNADO_R2_N12,
  ORACLE_CONSIGNADO_R2_N36,
  ORACLE_CONSIGNADO_R2_N60,
  ORACLE_CONSIGNADO_R3_N12,
  ORACLE_CONSIGNADO_R3_N24,
  ORACLE_CONSIGNADO_R3_N60,
  ORACLE_ONE_ZERO_RATE,
  ORACLE_PESSOAL_R1_D1,
  ORACLE_PESSOAL_R1_D15,
  ORACLE_PESSOAL_R1_D30,
  ORACLE_PESSOAL_R1_D60,
  ORACLE_PESSOAL_R2_D1,
  ORACLE_PESSOAL_R2_D15,
  ORACLE_PESSOAL_R2_D30,
  ORACLE_PESSOAL_R2_D60,
  ORACLE_SAVINGS_A_PAYOFF,
  ORACLE_SAVINGS_A_PERCENT,
  ORACLE_SAVINGS_A_SAVINGS,
  ORACLE_SAVINGS_B_PERCENT,
  ORACLE_SAVINGS_C_PERCENT,
  ORACLE_SAVINGS_C_SAVINGS,
  ORACLE_SEM_DESCONTO_1,
  ORACLE_SEM_DESCONTO_2,
  ORACLE_SEM_DESCONTO_3,
  ORACLE_ZERO_RATE_1,
  ORACLE_ZERO_RATE_12,
  ORACLE_ZERO_RATE_360,
} from './payoff.oracle.ts';

const BRL = 'BRL';
const money = (s: string) => Money.fromString(s, BRL);
const rate = (s: string) => Money.fromDecimal(new Decimal(s), BRL);

describe('calculateOutstandingBalance — precision (Decimal oracle)', () => {
  // Category 1: remainingInstallments === 0 → Money.zero
  it('returns Money.zero when remainingInstallments === 0 (consignado)', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('1500.00'),
      remainingInstallments: 0,
      monthlyInterestRate: rate('0.02'),
    });
    expect(r.equals(Money.zero(BRL))).toBe(true);
  });

  it('returns Money.zero when remainingInstallments === 0 (pessoal_diario)', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.PESSOAL_DIARIO,
      monthlyPayment: money('800.00'),
      remainingInstallments: 0,
      monthlyInterestRate: rate('0.025'),
      daysUntilNextPayment: 15,
    });
    expect(r.isZero()).toBe(true);
  });

  it('returns Money.zero when remainingInstallments is negative', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.SEM_DESCONTO,
      monthlyPayment: money('500.00'),
      remainingInstallments: -5,
      monthlyInterestRate: rate('0'),
    });
    expect(r.isZero()).toBe(true);
  });

  // Category 2: remainingInstallments === 1, rate zero → equals payment
  it('rate === 0, n === 1 → equals payment', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('500.00'),
      remainingInstallments: 1,
      monthlyInterestRate: rate('0'),
    });
    expect(r.toDbString()).toBe(ORACLE_ONE_ZERO_RATE);
  });

  // Category 3: rate === 0 for periods in {1, 12, 360}
  it('rate === 0, n === 1', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('500.00'),
      remainingInstallments: 1,
      monthlyInterestRate: rate('0'),
    });
    expect(r.toDbString()).toBe(ORACLE_ZERO_RATE_1);
  });

  it('rate === 0, n === 12', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('500.00'),
      remainingInstallments: 12,
      monthlyInterestRate: rate('0'),
    });
    expect(r.toDbString()).toBe(ORACLE_ZERO_RATE_12);
  });

  it('rate === 0, n === 360', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('500.00'),
      remainingInstallments: 360,
      monthlyInterestRate: rate('0'),
    });
    expect(r.toDbString()).toBe(ORACLE_ZERO_RATE_360);
  });

  // Category 4: consignado_mensal / cdc_veiculos (identical formula)
  // 3 rates × 3 periods = 9
  it('consignado_mensal r=0.0199 n=12', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('1500.00'),
      remainingInstallments: 12,
      monthlyInterestRate: rate('0.0199'),
    });
    expect(r.toDbString()).toBe(ORACLE_CONSIGNADO_R1_N12);
  });

  it('cdc_veiculos r=0.0199 n=12 matches consignado (identical formula)', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CDC_VEICULOS,
      monthlyPayment: money('1500.00'),
      remainingInstallments: 12,
      monthlyInterestRate: rate('0.0199'),
    });
    expect(r.toDbString()).toBe(ORACLE_CONSIGNADO_R1_N12);
  });

  it('consignado_mensal r=0.0199 n=36', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('1500.00'),
      remainingInstallments: 36,
      monthlyInterestRate: rate('0.0199'),
    });
    expect(r.toDbString()).toBe(ORACLE_CONSIGNADO_R1_N36);
  });

  it('consignado_mensal r=0.0085 n=360 (long horizon)', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('1234.56'),
      remainingInstallments: 360,
      monthlyInterestRate: rate('0.0085'),
    });
    expect(r.toDbString()).toBe(ORACLE_CONSIGNADO_R1_N360);
  });

  it('consignado_mensal r=0.025 n=12', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('2000.00'),
      remainingInstallments: 12,
      monthlyInterestRate: rate('0.025'),
    });
    expect(r.toDbString()).toBe(ORACLE_CONSIGNADO_R2_N12);
  });

  it('cdc_veiculos r=0.025 n=36', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CDC_VEICULOS,
      monthlyPayment: money('2000.00'),
      remainingInstallments: 36,
      monthlyInterestRate: rate('0.025'),
    });
    expect(r.toDbString()).toBe(ORACLE_CONSIGNADO_R2_N36);
  });

  it('consignado_mensal r=0.025 n=60', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('800.00'),
      remainingInstallments: 60,
      monthlyInterestRate: rate('0.025'),
    });
    expect(r.toDbString()).toBe(ORACLE_CONSIGNADO_R2_N60);
  });

  it('consignado_mensal r=0.25 n=12 (extreme high rate)', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('300.00'),
      remainingInstallments: 12,
      monthlyInterestRate: rate('0.25'),
    });
    expect(r.toDbString()).toBe(ORACLE_CONSIGNADO_R3_N12);
  });

  it('consignado_mensal r=0.25 n=24 (extreme high rate, longer)', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('300.00'),
      remainingInstallments: 24,
      monthlyInterestRate: rate('0.25'),
    });
    expect(r.toDbString()).toBe(ORACLE_CONSIGNADO_R3_N24);
  });

  it('consignado_mensal r=0.001 n=60 (extreme low rate)', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('800.00'),
      remainingInstallments: 60,
      monthlyInterestRate: rate('0.001'),
    });
    expect(r.toDbString()).toBe(ORACLE_CONSIGNADO_R3_N60);
  });

  // Category 5: pessoal_diario with days in {1, 15, 30, 60} × 2 rates = 8
  it('pessoal_diario r=0.025 n=20 d=1', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.PESSOAL_DIARIO,
      monthlyPayment: money('800.00'),
      remainingInstallments: 20,
      monthlyInterestRate: rate('0.025'),
      daysUntilNextPayment: 1,
    });
    expect(r.toDbString()).toBe(ORACLE_PESSOAL_R1_D1);
  });

  it('pessoal_diario r=0.025 n=20 d=15', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.PESSOAL_DIARIO,
      monthlyPayment: money('800.00'),
      remainingInstallments: 20,
      monthlyInterestRate: rate('0.025'),
      daysUntilNextPayment: 15,
    });
    expect(r.toDbString()).toBe(ORACLE_PESSOAL_R1_D15);
  });

  it('pessoal_diario r=0.025 n=20 d=30 (default-equivalent)', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.PESSOAL_DIARIO,
      monthlyPayment: money('800.00'),
      remainingInstallments: 20,
      monthlyInterestRate: rate('0.025'),
      daysUntilNextPayment: 30,
    });
    expect(r.toDbString()).toBe(ORACLE_PESSOAL_R1_D30);
  });

  it('pessoal_diario r=0.025 n=20 d=60', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.PESSOAL_DIARIO,
      monthlyPayment: money('800.00'),
      remainingInstallments: 20,
      monthlyInterestRate: rate('0.025'),
      daysUntilNextPayment: 60,
    });
    expect(r.toDbString()).toBe(ORACLE_PESSOAL_R1_D60);
  });

  it('pessoal_diario r=0.0199 n=33 d=1', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.PESSOAL_DIARIO,
      monthlyPayment: money('1500.00'),
      remainingInstallments: 33,
      monthlyInterestRate: rate('0.0199'),
      daysUntilNextPayment: 1,
    });
    expect(r.toDbString()).toBe(ORACLE_PESSOAL_R2_D1);
  });

  it('pessoal_diario r=0.0199 n=33 d=15', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.PESSOAL_DIARIO,
      monthlyPayment: money('1500.00'),
      remainingInstallments: 33,
      monthlyInterestRate: rate('0.0199'),
      daysUntilNextPayment: 15,
    });
    expect(r.toDbString()).toBe(ORACLE_PESSOAL_R2_D15);
  });

  it('pessoal_diario r=0.0199 n=33 d=30', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.PESSOAL_DIARIO,
      monthlyPayment: money('1500.00'),
      remainingInstallments: 33,
      monthlyInterestRate: rate('0.0199'),
      daysUntilNextPayment: 30,
    });
    expect(r.toDbString()).toBe(ORACLE_PESSOAL_R2_D30);
  });

  it('pessoal_diario r=0.0199 n=33 d=60', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.PESSOAL_DIARIO,
      monthlyPayment: money('1500.00'),
      remainingInstallments: 33,
      monthlyInterestRate: rate('0.0199'),
      daysUntilNextPayment: 60,
    });
    expect(r.toDbString()).toBe(ORACLE_PESSOAL_R2_D60);
  });

  // Category 6: sem_desconto
  it('sem_desconto 500 × 10 = 5000', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.SEM_DESCONTO,
      monthlyPayment: money('500.00'),
      remainingInstallments: 10,
      monthlyInterestRate: rate('0'),
    });
    expect(r.toDbString()).toBe(ORACLE_SEM_DESCONTO_1);
  });

  it('sem_desconto 1234.56 × 24 (exact multiplication, no rounding error)', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.SEM_DESCONTO,
      monthlyPayment: money('1234.56'),
      remainingInstallments: 24,
      monthlyInterestRate: rate('0'),
    });
    expect(r.toDbString()).toBe(ORACLE_SEM_DESCONTO_2);
  });

  it('sem_desconto 999.99 × 7', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.SEM_DESCONTO,
      monthlyPayment: money('999.99'),
      remainingInstallments: 7,
      monthlyInterestRate: rate('0'),
    });
    expect(r.toDbString()).toBe(ORACLE_SEM_DESCONTO_3);
  });

  // Category 9: currency mismatch guard
  it('throws when monthlyPayment and monthlyInterestRate currencies differ', () => {
    expect(() =>
      calculateOutstandingBalance({
        type: PayoffCalculationType.CONSIGNADO_MENSAL,
        monthlyPayment: Money.fromString('1500.00', 'BRL'),
        remainingInstallments: 12,
        monthlyInterestRate: Money.fromDecimal(new Decimal('0.02'), 'USD'),
      }),
    ).toThrow(/different currencies/);
  });

  // Output carries the input's currency
  it('output Money carries the input currency', () => {
    const r = calculateOutstandingBalance({
      type: PayoffCalculationType.SEM_DESCONTO,
      monthlyPayment: Money.fromString('100.00', 'USD'),
      remainingInstallments: 3,
      monthlyInterestRate: Money.fromDecimal(new Decimal('0'), 'USD'),
    });
    expect(r.currency).toBe('USD');
  });
});

describe('calculatePayoffSavings — precision (Decimal oracle)', () => {
  // Category 7a: positive savings
  it('positive savings with oracle-verified percent', () => {
    const payoff = calculateOutstandingBalance({
      type: PayoffCalculationType.CONSIGNADO_MENSAL,
      monthlyPayment: money('1500.00'),
      remainingInstallments: 33,
      monthlyInterestRate: rate('0.0199'),
    });
    expect(payoff.toDbString()).toBe(ORACLE_SAVINGS_A_PAYOFF);

    const { savings, savingsPercent } = calculatePayoffSavings(money('1500.00'), 33, payoff);
    expect(savings.toDbString()).toBe(ORACLE_SAVINGS_A_SAVINGS);
    expect(savingsPercent.toFixed(2)).toBe(ORACLE_SAVINGS_A_PERCENT);
  });

  // Category 7b: savings percent rounding edge — 1/3 → 33.33
  it('savings percent rounds 33.333... to 33.33 (ROUND_HALF_UP)', () => {
    // total = 300, payoff = 200, savings = 100 → 100/300 = 0.3333... → 33.33%
    const monthly = money('100.00');
    const payoff = money('200.00');
    const { savingsPercent } = calculatePayoffSavings(monthly, 3, payoff);
    expect(savingsPercent.toFixed(2)).toBe(ORACLE_SAVINGS_B_PERCENT);
  });

  // Category 7c: zero savings
  it('zero savings when payoff equals total', () => {
    const monthly = money('500.00');
    const payoff = money('5000.00'); // == 500 × 10
    const { savings, savingsPercent } = calculatePayoffSavings(monthly, 10, payoff);
    expect(savings.toDbString()).toBe(ORACLE_SAVINGS_C_SAVINGS);
    expect(savingsPercent.toFixed(2)).toBe(ORACLE_SAVINGS_C_PERCENT);
  });

  it('savingsPercent is 0 when totalIfPaying is 0 (zero remaining or zero payment)', () => {
    const { savingsPercent, savings } = calculatePayoffSavings(Money.zero(BRL), 0, Money.zero(BRL));
    expect(savingsPercent).toBe(0);
    expect(savings.isZero()).toBe(true);
  });

  it('currency mismatch in savings throws (via subtract)', () => {
    const monthly = Money.fromString('100.00', 'BRL');
    const payoff = Money.fromString('50.00', 'USD');
    expect(() => calculatePayoffSavings(monthly, 3, payoff)).toThrow(/different currencies/);
  });

  it('returns Money savings (not number)', () => {
    const { savings } = calculatePayoffSavings(money('500.00'), 10, money('4500.00'));
    expect(savings).toBeInstanceOf(Money);
    expect(savings.toDbString()).toBe('500.00');
  });
});
