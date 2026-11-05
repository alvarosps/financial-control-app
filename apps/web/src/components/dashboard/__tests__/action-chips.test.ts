import { describe, expect, it } from 'vitest';
import { buildActionChips, type UpcomingLike } from '@/components/dashboard/action-chips';

const now = new Date(2026, 6, 4);

function item(overrides: Partial<UpcomingLike>): UpcomingLike {
  return { kind: 'card', isPaid: false, dueDate: '2026-07-06', ...overrides };
}

describe('buildActionChips', () => {
  it('groups unpaid items due within 7 days into card and bill chips', () => {
    const chips = buildActionChips(
      [
        item({ kind: 'card', dueDate: '2026-07-05' }),
        item({ kind: 'card', dueDate: '2026-07-10' }),
        item({ kind: 'loan', dueDate: '2026-07-06' }),
        item({ kind: 'fixed_charge', dueDate: '2026-07-08' }),
      ],
      0,
      now,
    );

    expect(chips).toEqual([
      { id: 'cardsDue', count: 2 },
      { id: 'billsDue', count: 2 },
    ]);
  });

  it('ignores paid items and items outside the window', () => {
    const chips = buildActionChips(
      [
        item({ isPaid: true, dueDate: '2026-07-05' }),
        item({ dueDate: '2026-07-20' }),
        item({ kind: 'one_time_charge', dueDate: '2026-08-01' }),
      ],
      0,
      now,
    );

    expect(chips).toEqual([]);
  });

  it('adds an income-credited chip when auto-credit ran today', () => {
    expect(buildActionChips([], 2, now)).toEqual([{ id: 'incomeCredited', count: 2 }]);
  });
});
