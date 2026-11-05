/**
 * Oracle generator for payoff precision tests.
 *
 * Computes expected values using decimal.js at 50-digit precision,
 * rounded once to 2 decimals (ROUND_HALF_UP) at the output boundary — the
 * same discipline `payoff.ts` follows. Any divergence between the runtime
 * result and these oracle constants is a precision regression.
 *
 * Run:
 *   pnpm --filter @fc/domain exec tsx scripts/gen-payoff-oracle.ts \
 *     > src/__tests__/payoff.oracle.ts
 *
 * The generated file is COMMITTED and not regenerated in CI; drift is a
 * signal, not noise.
 */
import Decimal from 'decimal.js';

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

function pv(payment: Decimal, rate: Decimal, periods: number): Decimal {
  if (rate.isZero()) return payment.times(periods);
  if (periods === 0) return new Decimal(0);
  const factor = new Decimal(1).minus(new Decimal(1).plus(rate).pow(-periods));
  return payment.times(factor).dividedBy(rate);
}

function pvPessoalDiario(
  payment: Decimal,
  rate: Decimal,
  periods: number,
  daysUntilNext: number,
): Decimal {
  const one = new Decimal(1);
  const dailyRate = one.plus(rate).pow(one.dividedBy(30)).minus(1);
  const pvBase = pv(payment, rate, periods);
  return pvBase.times(one.plus(rate)).dividedBy(one.plus(dailyRate).pow(daysUntilNext));
}

const D = (x: string) => new Decimal(x);
const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

type Case = { name: string; value: string };
const out: Case[] = [];

// Category 1: remainingInstallments === 0 → zero (no oracle needed; test asserts Money.zero)

// Category 2: remainingInstallments === 1, rate zero → equals payment
out.push({ name: 'ORACLE_ONE_ZERO_RATE', value: round2(D('500.00').times(1)) });

// Category 3: rate === 0 for periods in {1, 12, 360}
out.push({ name: 'ORACLE_ZERO_RATE_1', value: round2(D('500.00').times(1)) });
out.push({ name: 'ORACLE_ZERO_RATE_12', value: round2(D('500.00').times(12)) });
out.push({ name: 'ORACLE_ZERO_RATE_360', value: round2(D('500.00').times(360)) });

// Category 4: consignado_mensal / cdc_veiculos (identical formula) — 3 rates × 3 periods = 9
const consignadoCases: Array<{ name: string; payment: string; rate: string; n: number }> = [
  { name: 'ORACLE_CONSIGNADO_R1_N12', payment: '1500.00', rate: '0.0199', n: 12 },
  { name: 'ORACLE_CONSIGNADO_R1_N36', payment: '1500.00', rate: '0.0199', n: 36 },
  { name: 'ORACLE_CONSIGNADO_R1_N360', payment: '1234.56', rate: '0.0085', n: 360 },
  { name: 'ORACLE_CONSIGNADO_R2_N12', payment: '2000.00', rate: '0.025', n: 12 },
  { name: 'ORACLE_CONSIGNADO_R2_N36', payment: '2000.00', rate: '0.025', n: 36 },
  { name: 'ORACLE_CONSIGNADO_R2_N60', payment: '800.00', rate: '0.025', n: 60 },
  { name: 'ORACLE_CONSIGNADO_R3_N12', payment: '300.00', rate: '0.25', n: 12 },
  { name: 'ORACLE_CONSIGNADO_R3_N24', payment: '300.00', rate: '0.25', n: 24 },
  { name: 'ORACLE_CONSIGNADO_R3_N60', payment: '800.00', rate: '0.001', n: 60 },
];
for (const c of consignadoCases) {
  out.push({ name: c.name, value: round2(pv(D(c.payment), D(c.rate), c.n)) });
}

// Category 5: pessoal_diario with daysUntilNextPayment in {1, 15, 30, 60} × 2 rates = 8
const pessoalCases: Array<{
  name: string;
  payment: string;
  rate: string;
  n: number;
  days: number;
}> = [
  { name: 'ORACLE_PESSOAL_R1_D1', payment: '800.00', rate: '0.025', n: 20, days: 1 },
  { name: 'ORACLE_PESSOAL_R1_D15', payment: '800.00', rate: '0.025', n: 20, days: 15 },
  { name: 'ORACLE_PESSOAL_R1_D30', payment: '800.00', rate: '0.025', n: 20, days: 30 },
  { name: 'ORACLE_PESSOAL_R1_D60', payment: '800.00', rate: '0.025', n: 20, days: 60 },
  { name: 'ORACLE_PESSOAL_R2_D1', payment: '1500.00', rate: '0.0199', n: 33, days: 1 },
  { name: 'ORACLE_PESSOAL_R2_D15', payment: '1500.00', rate: '0.0199', n: 33, days: 15 },
  { name: 'ORACLE_PESSOAL_R2_D30', payment: '1500.00', rate: '0.0199', n: 33, days: 30 },
  { name: 'ORACLE_PESSOAL_R2_D60', payment: '1500.00', rate: '0.0199', n: 33, days: 60 },
];
for (const c of pessoalCases) {
  out.push({ name: c.name, value: round2(pvPessoalDiario(D(c.payment), D(c.rate), c.n, c.days)) });
}

// Category 6: sem_desconto — 3 scenarios (payment × periods, no rate)
out.push({ name: 'ORACLE_SEM_DESCONTO_1', value: round2(D('500.00').times(10)) });
out.push({ name: 'ORACLE_SEM_DESCONTO_2', value: round2(D('1234.56').times(24)) });
out.push({ name: 'ORACLE_SEM_DESCONTO_3', value: round2(D('999.99').times(7)) });

// Category 7: calculatePayoffSavings oracles
// Case A: positive savings — consignado with payment=1500, n=33, rate=0.0199
const savingsA_payoff = pv(D('1500.00'), D('0.0199'), 33).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const savingsA_total = D('1500.00').times(33);
const savingsA_savings = savingsA_total.minus(savingsA_payoff);
const savingsA_percent = savingsA_savings
  .dividedBy(savingsA_total)
  .times(100)
  .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
out.push({ name: 'ORACLE_SAVINGS_A_PAYOFF', value: savingsA_payoff.toFixed(2) });
out.push({ name: 'ORACLE_SAVINGS_A_SAVINGS', value: savingsA_savings.toFixed(2) });
out.push({ name: 'ORACLE_SAVINGS_A_PERCENT', value: savingsA_percent.toFixed(2) });

// Case B: savings percent rounding edge — construct so savings/total = 1/3 → 33.33...%
// If total = 300, savings = 100 → percent = 33.33 (ROUND_HALF_UP of 33.333...)
out.push({ name: 'ORACLE_SAVINGS_B_PERCENT', value: '33.33' });

// Case C: zero savings — sem_desconto (payoff == total)
out.push({ name: 'ORACLE_SAVINGS_C_SAVINGS', value: '0.00' });
out.push({ name: 'ORACLE_SAVINGS_C_PERCENT', value: '0.00' });

// Emit
const header = `/**
 * Auto-generated by scripts/gen-payoff-oracle.ts.
 * DO NOT EDIT BY HAND. Regenerate only intentionally; committed so CI detects drift.
 */\n`;
process.stdout.write(header);
for (const c of out) {
  process.stdout.write(`export const ${c.name} = '${c.value}';\n`);
}
