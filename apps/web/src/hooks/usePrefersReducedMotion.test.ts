import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { mockMatchMedia } from '@/test/match-media';

describe('usePrefersReducedMotion', () => {
  beforeEach(() => {
    mockMatchMedia(false);
  });

  it('returns false when the media query does not match', () => {
    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);
  });

  it('returns true when prefers-reduced-motion: reduce matches', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(true);
  });
});
