import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installHistorySync,
  resetFakeSearchParams,
  setFakeSearchParams,
} from '@/test/next-navigation-fake';
import { useMonthNavigation, writeMonthYearToUrl } from './useMonthNavigation';

vi.mock('next/navigation', async () => {
  const fake = await import('@/test/next-navigation-fake');
  return { useSearchParams: fake.useFakeSearchParams };
});

describe('useMonthNavigation', () => {
  let restoreHistory: () => void;

  beforeEach(() => {
    window.history.replaceState(null, '', '/daily');
    resetFakeSearchParams();
    restoreHistory = installHistorySync();
  });

  afterEach(() => restoreHistory());

  it('uses valid URL values before initial props and falls back per parameter', () => {
    act(() => setFakeSearchParams('month=3&year=2025'));
    const { result, rerender } = renderHook(({ month, year }) => useMonthNavigation(month, year), {
      initialProps: { month: 6, year: 2026 },
    });
    expect(result.current).toMatchObject({ month: 3, year: 2025 });

    act(() => setFakeSearchParams('month=99&year=2025'));
    rerender({ month: 6, year: 2026 });
    expect(result.current).toMatchObject({ month: 6, year: 2025 });
  });

  it('writes navigation to the URL and updates without server navigation', () => {
    const { result } = renderHook(() => useMonthNavigation(6, 2026));
    act(() => result.current.goToNextMonth());
    expect(window.location.search).toBe('?month=7&year=2026');
    expect(result.current).toMatchObject({ month: 7, year: 2026 });
  });

  it('crosses year boundaries and preserves unrelated URL params', () => {
    act(() => setFakeSearchParams('month=12&year=2026'));
    const { result } = renderHook(() => useMonthNavigation());
    act(() => result.current.goToNextMonth());
    expect(result.current).toMatchObject({ month: 1, year: 2027 });

    act(() => {
      window.history.replaceState(null, '', '/transactions?foo=bar');
      writeMonthYearToUrl(5, 2026);
    });
    expect(new URLSearchParams(window.location.search)).toEqual(
      new URLSearchParams('foo=bar&month=5&year=2026'),
    );
  });
});
