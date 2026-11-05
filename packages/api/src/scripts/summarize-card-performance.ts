import { pathToFileURL } from 'node:url';

const CARD_PERFORMANCE_EVENTS = new Set([
  'credit_card.materialize',
  'credit_card.add_one_time',
  'credit_card.add_installment',
  'credit_card.edit_installment',
  'credit_card.add_fixed_charge',
  'credit_card.update_schedule',
  'credit_card.delete_schedule',
  'credit_card.add_refund',
  'credit_card.edit_transaction',
  'credit_card.reverse_transaction',
  'credit_card.update_config',
  'credit_card.create',
  'credit_card.update_metadata',
  'credit_card.create_additional',
  'credit_card.set_group_active',
  'fatura.create_draft',
  'fatura.apply',
  'credit_card.pay_bill',
]);

type PerformanceRecord = {
  event: string;
  scope?: string;
  outcome: 'success' | 'error';
  durationMs: number;
};

export type PerformanceSummary = {
  event: string;
  scope: string;
  outcome: 'success' | 'error';
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  insufficientEvidence: boolean;
};

function isPerformanceRecord(value: unknown): value is PerformanceRecord {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as {
    event?: unknown;
    scope?: unknown;
    outcome?: unknown;
    durationMs?: unknown;
  };
  return (
    typeof candidate.event === 'string' &&
    CARD_PERFORMANCE_EVENTS.has(candidate.event) &&
    (candidate.scope === undefined || typeof candidate.scope === 'string') &&
    (candidate.outcome === 'success' || candidate.outcome === 'error') &&
    typeof candidate.durationMs === 'number' &&
    Number.isFinite(candidate.durationMs)
  );
}

export function nearestRank(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((percentile / 100) * sorted.length) - 1] ?? null;
}

export function summarizeCardPerformance(lines: Iterable<string>): PerformanceSummary[] {
  const groups = new Map<string, PerformanceRecord[]>();

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPerformanceRecord(parsed)) continue;

    const scope = parsed.scope ?? 'none';
    const key = `${parsed.event}\u0000${scope}\u0000${parsed.outcome}`;
    const records = groups.get(key) ?? [];
    records.push(parsed);
    groups.set(key, records);
  }

  return [...groups.entries()]
    .map(([key, records]) => {
      const [event, scope, outcome] = key.split('\u0000') as [string, string, 'success' | 'error'];
      const durations = records.map((record) => record.durationMs);
      const successfulCount = outcome === 'success' ? records.length : 0;
      return {
        event,
        scope,
        outcome,
        count: records.length,
        p50Ms: nearestRank(durations, 50),
        p95Ms: nearestRank(durations, 95),
        insufficientEvidence: successfulCount < 30,
      };
    })
    .sort((left, right) =>
      `${left.event}\u0000${left.scope}\u0000${left.outcome}`.localeCompare(
        `${right.event}\u0000${right.scope}\u0000${right.outcome}`,
      ),
    );
}

async function readStdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk.toString();
  }
  return text;
}

async function main(): Promise<void> {
  const input = await readStdin();
  const summary = summarizeCardPerformance(input.split(/\r?\n/));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
