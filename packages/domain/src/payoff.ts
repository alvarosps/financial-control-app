import Decimal from 'decimal.js';
import { Money } from './money.ts';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export const PayoffCalculationType = {
  CONSIGNADO_MENSAL: 'consignado_mensal',
  PESSOAL_DIARIO: 'pessoal_diario',
  CDC_VEICULOS: 'cdc_veiculos',
  SEM_DESCONTO: 'sem_desconto',
} as const;

export type PayoffCalculationType =
  (typeof PayoffCalculationType)[keyof typeof PayoffCalculationType];

export type PayoffInput = {
  type: PayoffCalculationType;
  monthlyPayment: Money;
  remainingInstallments: number;
  /**
   * Monthly interest rate as a fraction (e.g. 0.01 for 1%/month). Pass as
   * `Money.fromDecimal(new Decimal('0.0085'), currency)` to preserve precision;
   * `Money.fromString('0.0085')` would round to 0.01 and corrupt the rate.
   */
  monthlyInterestRate: Money;
  daysUntilNextPayment?: number;
};

function presentValueDecimal(payment: Decimal, rate: Decimal, periods: number): Decimal {
  if (rate.isZero()) return payment.times(periods);
  if (periods === 0) return new Decimal(0);
  const factor = new Decimal(1).minus(new Decimal(1).plus(rate).pow(-periods));
  return payment.times(factor).dividedBy(rate);
}

/**
 * Compute the outstanding balance (payoff amount) for the given loan type.
 *
 * Uses `Decimal` end-to-end at 30-digit precision; rounds exactly once at the
 * Money boundary (ROUND_HALF_UP, 2dp). The returned Money shares the currency
 * of `monthlyPayment`.
 */
export function calculateOutstandingBalance(input: PayoffInput): Money {
  const { type, monthlyPayment, remainingInstallments, monthlyInterestRate } = input;
  if (monthlyPayment.currency !== monthlyInterestRate.currency) {
    throw new Error(
      `Cannot operate on different currencies: ${monthlyPayment.currency} vs ${monthlyInterestRate.currency}`,
    );
  }
  const currency = monthlyPayment.currency;
  if (remainingInstallments <= 0) return Money.zero(currency);

  const pay = monthlyPayment.toDecimal();
  const rate = monthlyInterestRate.toDecimal();

  let result: Decimal;
  switch (type) {
    case PayoffCalculationType.CONSIGNADO_MENSAL:
    case PayoffCalculationType.CDC_VEICULOS:
      result = presentValueDecimal(pay, rate, remainingInstallments);
      break;
    case PayoffCalculationType.PESSOAL_DIARIO: {
      const one = new Decimal(1);
      const dailyRate = one.plus(rate).pow(one.dividedBy(30)).minus(1);
      // Immediate annuity PV already discounts payment 1 by one full period
      // (30 days). Reposition the whole cashflow so the next payment is `days`
      // days from today: pv * (1 + monthlyRate) / (1 + dailyRate)^days.
      const pv = presentValueDecimal(pay, rate, remainingInstallments);
      const days = input.daysUntilNextPayment ?? 30;
      result = pv.times(one.plus(rate)).dividedBy(one.plus(dailyRate).pow(days));
      break;
    }
    case PayoffCalculationType.SEM_DESCONTO:
      result = pay.times(remainingInstallments);
      break;
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown payoff type: ${_exhaustive as string}`);
    }
  }
  return Money.fromDecimal(result.toDecimalPlaces(2, Decimal.ROUND_HALF_UP), currency);
}

/**
 * Compute the savings of paying off early vs. continuing installments.
 *
 * `savingsPercent` is rounded to 2 decimals (ROUND_HALF_UP) and returned as a
 * number for display convenience — math uses Decimal internally.
 */
export function calculatePayoffSavings(
  monthlyPayment: Money,
  remainingInstallments: number,
  payoffAmount: Money,
): { savings: Money; savingsPercent: number } {
  const totalIfPaying = monthlyPayment.multiply(remainingInstallments);
  const savings = totalIfPaying.subtract(payoffAmount);
  const totalDec = totalIfPaying.toDecimal();
  const savingsPercent = totalDec.isZero()
    ? 0
    : savings
        .toDecimal()
        .dividedBy(totalDec)
        .times(100)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toNumber();
  return { savings, savingsPercent };
}
