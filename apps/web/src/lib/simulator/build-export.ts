// apps/web/src/lib/simulator/build-export.ts
import type { ProjectedMonth } from '@fc/domain';
import type { SimLever, SimScenario } from '@fc/shared';
import { formatCurrency } from '@/lib/format';
import type { RunResult, ScenarioExport } from './export-types';

const DEFAULT_QUESTION =
  'Is this plan sustainable? Where do I risk going negative and what would you change?';

function mm(month: number, year: number): string {
  return `${String(month).padStart(2, '0')}/${year}`;
}

// Sanitize free-text (user-provided labels, ids) before interpolating into
// markdown: escape the pipe so it can't break table cells, and flatten any CR/LF
// so a label can't inject extra lines into the bullet list or the AI prompt.
function escapeInline(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
}

function leverLine(lever: SimLever): string {
  switch (lever.kind) {
    case 'loan_payoff':
      return `- Loan payoff (loan ${escapeInline(lever.loanAccountId)}) at ${mm(
        lever.targetMonth.month,
        lever.targetMonth.year,
      )}${
        lever.partialAmount
          ? ` — partial ${formatCurrency(Number.parseFloat(lever.partialAmount))}`
          : ''
      }`;
    case 'income_change':
      return `- Income ${lever.op} "${escapeInline(lever.label)}"${
        lever.amount ? ` ${formatCurrency(Number.parseFloat(lever.amount))}` : ''
      }${lever.percent != null ? ` ${lever.percent}%` : ''} (${lever.frequency}) from ${mm(
        lever.fromMonth.month,
        lever.fromMonth.year,
      )}${lever.toMonth ? ` to ${mm(lever.toMonth.month, lever.toMonth.year)}` : ''}`;
    case 'one_time_event':
      return `- One-time ${lever.sign} "${escapeInline(lever.label)}" ${formatCurrency(
        Number.parseFloat(lever.amount),
      )} on ${mm(lever.month.month, lever.month.year)}`;
    case 'recurring_change':
      return `- Recurring ${lever.op} "${escapeInline(lever.label)}"${
        lever.amount ? ` ${formatCurrency(Number.parseFloat(lever.amount))}` : ''
      }${lever.frequency ? ` (${lever.frequency})` : ''}`;
    case 'savings_goal':
      return `- Savings goal "${escapeInline(lever.label)}" target ${formatCurrency(
        Number.parseFloat(lever.target),
      )} by ${mm(lever.byMonth.month, lever.byMonth.year)}`;
    case 'average_spend':
      return `- Average spend "${escapeInline(lever.label)}" ${formatCurrency(
        Number.parseFloat(lever.amount),
      )}/mo from ${mm(lever.fromMonth.month, lever.fromMonth.year)}`;
    case 'installment_growth':
      return `- New installment "${escapeInline(lever.label)}" ${formatCurrency(
        Number.parseFloat(lever.monthlyAmount),
      )}/mo ${
        lever.termMonths != null ? `× ${lever.termMonths} rolling` : '(accumulating)'
      } from ${mm(lever.fromMonth.month, lever.fromMonth.year)}`;
    case 'installment_plan':
      return `- Installment plan "${escapeInline(lever.label)}" ${formatCurrency(
        Number.parseFloat(lever.amount),
      )}/mo × ${lever.installments} from ${mm(lever.startMonth.month, lever.startMonth.year)}`;
  }
}

function monthRow(s: ProjectedMonth): string {
  // Every column comes from the simulated row so the table stays internally
  // consistent (Opening + Net = Ending). Levers shift earlier months' net, so a
  // later month's simulated opening diverges from the baseline opening.
  return `| ${mm(s.month, s.year)} | ${formatCurrency(s.openingBalance)} | ${formatCurrency(
    s.income.total,
  )} | ${formatCurrency(s.expenses.total)} | ${formatCurrency(s.net)} | ${formatCurrency(
    s.endingBalance,
  )} |`;
}

function alertLine(label: string, ref: { month: number; year: number } | null): string {
  return `- ${label}: ${ref ? mm(ref.month, ref.year) : 'none'}`;
}

export function buildMarkdown(run: RunResult, scenario: SimScenario): string {
  const { assumptions, kpis, alerts, simulated } = run;
  const lines: string[] = [];

  lines.push(`# Scenario: ${escapeInline(scenario.name)}`, '');
  lines.push('## Assumptions', '');
  lines.push(`- Projection opening (next month): ${formatCurrency(run.openingBalance)}`);
  lines.push(`- Anchor cash: ${formatCurrency(run.anchorCash)}`);
  // The current (partial) month is folded into the opening balance; the table
  // and projection start at the next full month.
  if (simulated.length > 0) {
    lines.push(
      `- Projection starts: ${mm(simulated[0].month, simulated[0].year)} (current partial month folded into the opening)`,
    );
  }
  lines.push(`- Anchor source: ${assumptions.anchorSource}`);
  lines.push(`- Opening overridden: ${assumptions.openingBalanceOverridden ? 'yes' : 'no'}`);
  lines.push(`- Horizon: ${assumptions.horizon} months`);
  lines.push(`- As of: ${assumptions.asOf}`);
  lines.push(`- Currency: ${assumptions.currency}`, '');

  lines.push(
    `- Family receipts: ${assumptions.familyReceiptPercent}% of unreceived allocated balances (estimate, no settlement)`,
  );
  lines.push(`- Scenario FX overrides: ${JSON.stringify(assumptions.exchangeRates ?? {})}`);
  lines.push(
    `- Incomplete BRL months (missing FX): ${
      run.forecast
        .filter((month) => month.incomeUnavailableCount > 0)
        .map((month) => mm(month.month, month.year))
        .join(', ') || 'none'
    }`,
  );
  for (const month of run.forecast) {
    lines.push(
      `- Family ${mm(month.month, month.year)}: owed ${month.familyOwed}, allocated ${month.familyAllocated}, remaining ${month.familyRemaining}`,
    );
    for (const source of month.sources.filter((source) => source.currency !== 'BRL'))
      lines.push(
        `- Configured FX ${escapeInline(source.name)}: ${source.configRate ?? 'unavailable'} BRL/${source.currency}; fee ${source.conversionFeePercent ?? '0'}%; config updated ${source.configUpdatedAt?.toISOString() ?? 'unknown'} (not a live quote)`,
      );
  }
  lines.push('## KPIs', '');
  lines.push(`- Opening now: ${formatCurrency(kpis.openingNow)}`);
  lines.push(`- Ending (baseline): ${formatCurrency(kpis.endingBaseline)}`);
  lines.push(`- Ending (simulated): ${formatCurrency(kpis.endingSimulated)}`);
  lines.push(`- Delta: ${formatCurrency(kpis.delta)}`, '');

  lines.push('## Month table (simulated)', '');
  lines.push('| Month | Opening | Income | Expenses | Net | Ending |');
  lines.push('|---|---|---|---|---|---|');
  for (const s of simulated) {
    lines.push(monthRow(s));
  }
  lines.push('');

  lines.push('## Levers', '');
  if (scenario.levers.length === 0) {
    lines.push('- (none)');
  } else {
    for (const lever of scenario.levers) lines.push(leverLine(lever));
  }
  lines.push('');

  lines.push('## Alerts', '');
  lines.push(alertLine('First negative month (baseline)', alerts.firstNegativeMonthBaseline));
  lines.push(alertLine('First negative month (simulated)', alerts.firstNegativeMonthSimulated));
  lines.push(
    `- Trough (baseline): ${formatCurrency(alerts.troughBaseline.balance)} at ${mm(
      alerts.troughBaseline.month,
      alerts.troughBaseline.year,
    )}`,
  );
  lines.push(
    `- Trough (simulated): ${formatCurrency(alerts.troughSimulated.balance)} at ${mm(
      alerts.troughSimulated.month,
      alerts.troughSimulated.year,
    )}`,
  );

  return lines.join('\n');
}

export function buildExport(
  run: RunResult,
  scenario: SimScenario,
  question = DEFAULT_QUESTION,
): ScenarioExport {
  const markdown = buildMarkdown(run, scenario);
  // schemaVersion is an intentional, versioned export contract: bump it when the
  // JSON shape changes so downstream consumers can detect/migrate older exports.
  const json = JSON.stringify({ schemaVersion: 2, run, scenario }, null, 2);
  const prompt = [
    'You are a personal-finance analyst. Below is a cash-flow projection scenario',
    'exported from a personal finance app. All amounts are in BRL.',
    '',
    markdown,
    '',
    `Question: ${question}`,
  ].join('\n');
  return { markdown, json, prompt };
}
