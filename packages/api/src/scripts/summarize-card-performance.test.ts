import { describe, expect, it } from 'vitest';

import { nearestRank, summarizeCardPerformance } from './summarize-card-performance.ts';

describe('summarizeCardPerformance', () => {
  it('ignores malformed and non-card logs', () => {
    expect(
      summarizeCardPerformance(['not json', '{"event":"account.create","durationMs":1}']),
    ).toEqual([]);
  });

  it('keeps scopes and outcomes separate with nearest-rank percentiles', () => {
    const summary = summarizeCardPerformance([
      '{"event":"credit_card.materialize","scope":"targeted","outcome":"success","durationMs":10}',
      '{"event":"credit_card.materialize","scope":"targeted","outcome":"success","durationMs":20}',
      '{"event":"credit_card.materialize","scope":"full","outcome":"error","durationMs":30}',
    ]);

    expect(summary).toEqual([
      {
        event: 'credit_card.materialize',
        scope: 'full',
        outcome: 'error',
        count: 1,
        p50Ms: 30,
        p95Ms: 30,
        insufficientEvidence: true,
      },
      {
        event: 'credit_card.materialize',
        scope: 'targeted',
        outcome: 'success',
        count: 2,
        p50Ms: 10,
        p95Ms: 20,
        insufficientEvidence: true,
      },
    ]);
  });

  it('marks fewer than thirty successful samples as insufficient', () => {
    const lines = Array.from(
      { length: 30 },
      (_, index) =>
        `{"event":"credit_card.pay_bill","outcome":"success","durationMs":${index + 1}}`,
    );
    const [summary] = summarizeCardPerformance(lines);

    expect(summary?.insufficientEvidence).toBe(false);
    expect(summary?.p50Ms).toBe(15);
    expect(summary?.p95Ms).toBe(29);
  });

  it('calculates nearest rank for empty, odd, and even inputs', () => {
    expect(nearestRank([], 95)).toBeNull();
    expect(nearestRank([3], 50)).toBe(3);
    expect(nearestRank([1, 2, 3, 4], 50)).toBe(2);
  });
});
