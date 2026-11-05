import { describe, expect, it } from 'vitest';
import { buildFamilyLoanMonthlyReport, type FamilyLoanMonthlyReport } from './build-monthly-report';

const labels: FamilyLoanMonthlyReport['labels'] = {
  description: 'Descrição',
  value: 'Valor',
  installment: 'Parcela',
  sections: {
    cards: { title: 'CARTÕES (+)', total: 'TOTAL CARTÕES' },
    installments: { title: 'PARCELAS (+)', total: 'TOTAL PARCELAS' },
    fixedCharges: { title: 'COBRANÇAS FIXAS (+)', total: 'TOTAL FIXAS' },
    oneTimeCharges: { title: 'ÚNICOS DO MÊS (+)', total: 'TOTAL ÚNICOS' },
    discounts: { title: 'DESCONTOS (-)', total: 'TOTAL DESCONTOS' },
  },
};

function fixture(overrides: Partial<FamilyLoanMonthlyReport> = {}): FamilyLoanMonthlyReport {
  return {
    month: 7,
    year: 2026,
    labels,
    totals: {
      grandTotal: 10502.8,
      cards: 1160.35,
      installments: 1531,
      fixedCharges: 0,
      oneTimeCharges: 600,
      discounts: 337.5,
    },
    cards: [
      { description: 'Samsung', amount: '923.25' },
      { description: 'Trigg', amount: '62.10' },
      { description: 'Players', amount: '175.00' },
    ],
    installments: [
      {
        description: 'Financiamento Strada',
        amount: '1531.00',
        installmentNumber: 19,
        totalInstallments: 35,
      },
    ],
    fixedCharges: [],
    oneTimeCharges: [{ description: 'Zaffari', amount: '600.00' }],
    discounts: [
      {
        description: 'Máquina secar roupas',
        amount: '337.50',
        installmentNumber: 11,
        totalInstallments: 12,
      },
    ],
    ...overrides,
  };
}

describe('buildFamilyLoanMonthlyReport', () => {
  it('uses the selected language for the exported month heading', () => {
    const report = buildFamilyLoanMonthlyReport(fixture({ locale: 'en' }));
    expect(report.startsWith('JULY/2026')).toBe(true);
  });
  it('formats canonical totals and aligned installment columns for WhatsApp', () => {
    const report = buildFamilyLoanMonthlyReport(fixture());

    expect(report.startsWith('JULHO/2026')).toBe(true);
    expect(report.endsWith('```')).toBe(false);
    expect(report).toContain('R$ 10.502,80');
    expect(report).toMatch(/TOTAL CARTÕES\s+R\$\s+1\.160,35/);
    expect(report).toMatch(/TOTAL PARCELAS\s+R\$\s+1\.531,00/);
    expect(report).toMatch(/TOTAL DESCONTOS\s+-R\$\s+337,50/);
    expect(report).toContain('19/35');
    expect(report).not.toContain('COBRANÇAS FIXAS (+)');

    const installmentLines = report
      .split('\n')
      .filter((line) => line.includes('Valor') || line.includes('R$ 1.531,00'));
    const valueIndexes = installmentLines.map((line) =>
      line.indexOf('Valor') >= 0 ? line.indexOf('Valor') : line.indexOf('R$'),
    );
    expect(new Set(valueIndexes).size).toBe(1);
  });

  it('uses canonical totals even when fixture items do not add up', () => {
    const report = buildFamilyLoanMonthlyReport(
      fixture({
        cards: [{ description: 'Divergente', amount: '1.00' }],
        totals: { ...fixture().totals, cards: 999.99 },
      }),
    );
    expect(report).toMatch(/TOTAL CARTÕES\s+R\$\s+999,99/);
  });

  it('normalizes unicode, whitespace and backticks and wraps long descriptions', () => {
    const report = buildFamilyLoanMonthlyReport(
      fixture({
        cards: [
          {
            description: 'Cafe\u0301   ``` superextraordinariamentecomprido 😄😄😄',
            amount: '10.00',
          },
        ],
      }),
    );
    expect(report).toContain("Café '''");
    expect(report).not.toContain('``` super');
    expect(report).toContain('superextraordinariamente');
  });

  it('keeps a non-empty zero-total section visible without negative zero', () => {
    const report = buildFamilyLoanMonthlyReport(
      fixture({
        discounts: [{ description: 'Ajuste', amount: '0.00' }],
        totals: { ...fixture().totals, discounts: -0 },
      }),
    );
    expect(report).toContain('DESCONTOS (-)');
    expect(report).toMatch(/TOTAL DESCONTOS\s+R\$\s+0,00/);
    expect(report).not.toContain('-R$ 0,00');
  });

  it('sorts equal-installment items deterministically', () => {
    const report = buildFamilyLoanMonthlyReport(
      fixture({
        installments: [
          { description: 'Zulu', amount: '2.00', installmentNumber: 2, totalInstallments: 3 },
          { description: 'Álvaro', amount: '1.00', installmentNumber: 2, totalInstallments: 3 },
        ],
      }),
    );
    expect(report.indexOf('Álvaro')).toBeLessThan(report.indexOf('Zulu'));
  });
});
