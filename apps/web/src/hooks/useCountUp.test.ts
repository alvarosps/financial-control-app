import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCountUp } from '@/hooks/useCountUp';
import { mockMatchMedia } from '@/test/match-media';

describe('useCountUp', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'performance'] });
    mockMatchMedia(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at 0 and lands exactly on the target after the duration', () => {
    const { result } = renderHook(() => useCountUp(1000, 600), { wrapper: StrictMode });

    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(result.current).toBe(1000);
  });

  it('returns the target immediately under prefers-reduced-motion', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useCountUp(1000, 600));

    expect(result.current).toBe(1000);
  });

  it('snaps without animation when the target changes after mount', () => {
    const { result, rerender } = renderHook(({ value }) => useCountUp(value, 600), {
      initialProps: { value: 1000 },
    });

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(result.current).toBe(1000);

    rerender({ value: 2000 });

    expect(result.current).toBe(2000);
  });

  it('keeps snapping after a target returns to its initial value', () => {
    const { result, rerender } = renderHook(({ value }) => useCountUp(value, 600), {
      initialProps: { value: 1000 },
    });

    rerender({ value: 2000 });
    expect(result.current).toBe(2000);

    rerender({ value: 1000 });
    expect(result.current).toBe(1000);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current).toBe(1000);
  });

  it('animates negative targets symmetrically', () => {
    const { result } = renderHook(() => useCountUp(-500, 600));

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(result.current).toBe(-500);
  });
});
