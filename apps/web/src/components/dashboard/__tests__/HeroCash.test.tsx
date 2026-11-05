import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDeltaVs30d, HeroCashView } from '@/components/dashboard/HeroCash';
import { mockMatchMedia } from '@/test/match-media';
import { renderWithProviders } from '@/test/render';

describe('HeroCashView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 10, 12));
    mockMatchMedia(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('shows the hero label and the real cash value', () => {
    const { getByText } = renderWithProviders(
      <HeroCashView cashToday={1234.56} deltaVs30d={200} points={[]} />,
    );

    expect(getByText('Caixa real hoje')).toBeInTheDocument();
    expect(getByText(/1\.234,56/)).toBeInTheDocument();
  });

  it('shows a signed delta vs 30 days ago', () => {
    const { getByText } = renderWithProviders(
      <HeroCashView cashToday={1234.56} deltaVs30d={-150} points={[]} />,
    );

    expect(getByText(/-R\$ 150,00 vs 30 dias atrás/)).toBeInTheDocument();
  });

  it('omits the delta row when there is no series baseline', () => {
    const { queryByText } = renderWithProviders(<HeroCashView cashToday={100} points={[]} />);

    expect(queryByText(/vs 30 dias atrás/)).not.toBeInTheDocument();
  });

  it('omits the delta when the series begins at an anchor inside the 30-day window', () => {
    expect(
      getDeltaVs30d(1_200, [
        { date: '2026-06-30', total: 1_000 },
        { date: '2026-07-10', total: 1_200 },
      ]),
    ).toBeUndefined();
  });

  it('uses the baseline only when the series begins exactly 30 civil days ago', () => {
    expect(
      getDeltaVs30d(1_200, [
        { date: '2026-06-10', total: 1_000 },
        { date: '2026-07-10', total: 1_200 },
      ]),
    ).toBe(200);
  });

  it('uses the Sao Paulo calendar when the device timezone is behind it', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    vi.setSystemTime(new Date('2026-07-10T03:30:00.000Z'));

    expect(
      getDeltaVs30d(1_200, [
        { date: '2026-06-10', total: 1_000 },
        { date: '2026-07-10', total: 1_200 },
      ]),
    ).toBe(200);
  });
});
