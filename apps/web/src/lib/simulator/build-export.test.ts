// apps/web/src/lib/simulator/build-export.test.ts
import type { ProjectedMonth } from '@fc/domain';
import type { SimScenario } from '@fc/shared';
import { describe, expect, it } from 'vitest';
import { buildExport } from './build-export';
import type { RunResult } from './export-types';

function month(
  m: number,
  year: number,
  opening: number,
  net: number,
  income: number,
  expenses: number,
): ProjectedMonth {
  return {
    month: m,
    year,
    openingBalance: opening,
    income: { base: income, familyLoan: 0, lever: 0, total: income },
    expenses: { creditCard: expenses, loan: 0, charge: 0, other: 0, lever: 0, total: expenses },
    net,
    endingBalance: opening + net,
    events: [],
  };
}

const baseline: ProjectedMonth[] = [
  month(6, 2026, 1000, 500, 2000, 1500),
  month(7, 2026, 1500, -200, 1800, 2000),
];
const simulated: ProjectedMonth[] = [
  {
    ...month(6, 2026, 1000, 700, 2200, 1500),
    income: { base: 2000, familyLoan: 0, lever: 200, total: 2200 },
  },
  month(7, 2026, 1700, -200, 1800, 2000),
];

const RUN: RunResult = {
  anchorCash: 1000,
  openingBalance: 1000,
  baseline,
  simulated,
  kpis: { openingNow: 1000, endingBaseline: 1300, endingSimulated: 1500, delta: 200 },
  alerts: {
    firstNegativeMonthBaseline: null,
    firstNegativeMonthSimulated: null,
    troughBaseline: { month: 6, year: 2026, balance: 1300 },
    troughSimulated: { month: 6, year: 2026, balance: 1500 },
  },
  forecast: [],
  assumptions: {
    familyReceiptPercent: 100,
    horizon: 2,
    anchorSource: 'wallet_cash',
    openingBalanceOverridden: false,
    asOf: '2026-06-16',
    currency: 'BRL',
  },
};

const SCENARIO: SimScenario = {
  name: 'Quitar empréstimo',
  horizon: 2,
  levers: [
    {
      kind: 'income_change',
      id: 'lev-1',
      op: 'add',
      amount: '200.00',
      frequency: 'monthly',
      fromMonth: { month: 6, year: 2026 },
      label: 'Renda extra',
    },
    {
      kind: 'average_spend',
      id: 'lev-2',
      amount: '5000.00',
      fromMonth: { month: 6, year: 2026 },
      label: 'Gasto médio',
    },
    {
      kind: 'installment_growth',
      id: 'lev-3',
      monthlyAmount: '500.00',
      fromMonth: { month: 7, year: 2026 },
      label: 'Parcela nova/mês',
    },
    {
      kind: 'installment_plan',
      id: 'lev-4',
      amount: '500.00',
      installments: 12,
      startMonth: { month: 8, year: 2026 },
      label: 'Notebook 12x',
    },
  ],
};

describe('buildExport', () => {
  it('returns markdown, json and prompt artifacts', () => {
    const out = buildExport(RUN, SCENARIO);
    expect(out).toHaveProperty('markdown');
    expect(out).toHaveProperty('json');
    expect(out).toHaveProperty('prompt');
  });

  it('markdown contains the scenario name, assumptions, a month table, levers and alerts', () => {
    const { markdown } = buildExport(RUN, SCENARIO);
    expect(markdown).toContain('Quitar empréstimo');
    expect(markdown).toContain('Horizon');
    expect(markdown).toContain('| Month |'); // table header
    expect(markdown).toContain('06/2026'); // a month row
    expect(markdown).toContain('Renda extra'); // lever
    expect(markdown).toContain('Alerts'); // alerts section
  });

  it('markdown renders the average_spend and installment_growth lever lines', () => {
    const { markdown } = buildExport(RUN, SCENARIO);
    const averageLine = markdown
      .split('\n')
      .find((line) => line.startsWith('- Average spend "Gasto médio"'));
    expect(averageLine).toBeDefined();
    expect(averageLine).toContain('/mo from 06/2026');

    const installmentLine = markdown
      .split('\n')
      .find((line) => line.startsWith('- New installment "Parcela nova/mês"'));
    expect(installmentLine).toBeDefined();
    expect(installmentLine).toContain('/mo (accumulating) from 07/2026');
  });

  it('markdown shows the rolling term when installment_growth has termMonths', () => {
    const scenario: SimScenario = {
      ...SCENARIO,
      levers: [
        {
          kind: 'installment_growth',
          id: 'lev-roll',
          monthlyAmount: '500.00',
          termMonths: 12,
          fromMonth: { month: 7, year: 2026 },
          label: 'Parcela nova/mês',
        },
      ],
    };
    const { markdown } = buildExport(RUN, scenario);
    const line = markdown
      .split('\n')
      .find((l) => l.startsWith('- New installment "Parcela nova/mês"'));
    expect(line).toContain('/mo × 12 rolling from 07/2026');
  });

  it('markdown renders the installment_plan lever line', () => {
    const { markdown } = buildExport(RUN, SCENARIO);
    const line = markdown
      .split('\n')
      .find((l) => l.startsWith('- Installment plan "Notebook 12x"'));
    expect(line).toBeDefined();
    expect(line).toContain('× 12 from 08/2026');
  });

  it('month table uses the simulated opening and each row satisfies Opening + Net = Ending', () => {
    const { markdown } = buildExport(RUN, SCENARIO);
    // Levers shift June's net, so July's simulated opening (1700) diverges from
    // the baseline opening (1500). The table must show the simulated opening.
    const julyRow = markdown.split('\n').find((line) => line.startsWith('| 07/2026 |'));
    expect(julyRow).toBeDefined();

    // Parse "| 07/2026 | Opening | Income | Expenses | Net | Ending |".
    const cells = (julyRow ?? '')
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    const toNumber = (formatted: string): number =>
      Number.parseFloat(
        formatted
          .replace(/[^\d,-]/g, '')
          .replace(/\./g, '')
          .replace(',', '.'),
      );
    const opening = toNumber(cells[1]);
    const net = toNumber(cells[4]);
    const ending = toNumber(cells[5]);

    expect(opening).toBe(1700); // simulated opening, NOT the baseline 1500
    expect(opening + net).toBeCloseTo(ending, 2); // row is internally consistent
  });

  it('json is a versioned, parseable payload carrying the run and scenario', () => {
    const { json } = buildExport(RUN, SCENARIO);
    const parsed = JSON.parse(json) as {
      schemaVersion: number;
      run: RunResult;
      scenario: SimScenario;
    };
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.run.kpis.delta).toBe(200);
    expect(parsed.scenario.name).toBe('Quitar empréstimo');
    expect(parsed.scenario.levers).toHaveLength(4);
  });

  it('prompt embeds the markdown and a default editable question', () => {
    const { markdown, prompt } = buildExport(RUN, SCENARIO);
    expect(prompt).toContain('personal-finance analyst');
    expect(prompt).toContain(markdown);
    expect(prompt).toContain('Is this plan sustainable');
  });

  it('accepts a custom question and substitutes it into the prompt', () => {
    const { prompt } = buildExport(RUN, SCENARIO, 'Devo quitar agora?');
    expect(prompt).toContain('Devo quitar agora?');
    expect(prompt).not.toContain('Is this plan sustainable');
  });

  it('escapes pipes and flattens newlines in user-provided lever labels', () => {
    const scenario: SimScenario = {
      name: 'Injection',
      horizon: 2,
      levers: [
        {
          kind: 'average_spend',
          id: 'lev-x',
          amount: '100.00',
          fromMonth: { month: 6, year: 2026 },
          label: 'Netflix | HBO\nfoo',
        },
      ],
    };
    const { markdown } = buildExport(RUN, scenario);
    const leverLine = markdown.split('\n').find((line) => line.startsWith('- Average spend'));
    expect(leverLine).toBeDefined();
    // Pipe is escaped so it can't break a markdown table cell.
    expect(leverLine).toContain('Netflix \\| HBO foo');
    // The label's raw newline is flattened, so the lever stays on a single line.
    expect(leverLine).not.toMatch(/\n/);
    expect(markdown).not.toContain('Netflix | HBO');
  });
});
