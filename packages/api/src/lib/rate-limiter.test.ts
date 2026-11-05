import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rate-limiter.ts';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows N requests up to capacity then blocks until refill', () => {
    const limiter = createRateLimiter({ capacity: 3, refillPerSec: 1 });

    expect(limiter.tryAcquire('k')).toBe(true);
    expect(limiter.tryAcquire('k')).toBe(true);
    expect(limiter.tryAcquire('k')).toBe(true);
    // Bucket is now empty.
    expect(limiter.tryAcquire('k')).toBe(false);

    // Still blocked immediately after.
    expect(limiter.tryAcquire('k')).toBe(false);

    // After 1s we get 1 token back.
    vi.advanceTimersByTime(1000);
    expect(limiter.tryAcquire('k')).toBe(true);
    expect(limiter.tryAcquire('k')).toBe(false);
  });

  it('keeps buckets independent per key', () => {
    const limiter = createRateLimiter({ capacity: 2, refillPerSec: 1 });

    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);

    // 'b' must not share tokens with 'a'.
    expect(limiter.tryAcquire('b')).toBe(true);
    expect(limiter.tryAcquire('b')).toBe(true);
    expect(limiter.tryAcquire('b')).toBe(false);
  });

  it('saturates refill at capacity even after long idle', () => {
    const limiter = createRateLimiter({ capacity: 2, refillPerSec: 1 });

    // Drain the bucket.
    expect(limiter.tryAcquire('k')).toBe(true);
    expect(limiter.tryAcquire('k')).toBe(true);
    expect(limiter.tryAcquire('k')).toBe(false);

    // Wait an hour — refill would mathematically be 3600, but capped at 2.
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(limiter.tryAcquire('k')).toBe(true);
    expect(limiter.tryAcquire('k')).toBe(true);
    // Capacity is 2; the hour-long idle must not hand out a third token.
    expect(limiter.tryAcquire('k')).toBe(false);
  });

  it('accumulates fractional refill correctly', () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1 });

    // Consume the single token.
    expect(limiter.tryAcquire('k')).toBe(true);
    expect(limiter.tryAcquire('k')).toBe(false);

    // 500ms -> +0.5 tokens, still below 1, still blocked.
    vi.advanceTimersByTime(500);
    expect(limiter.tryAcquire('k')).toBe(false);

    // Another 600ms -> +0.6 more. Total 1.1 >= 1, unblocks once.
    vi.advanceTimersByTime(600);
    expect(limiter.tryAcquire('k')).toBe(true);
    // And the residual (~0.1) is not enough for a second.
    expect(limiter.tryAcquire('k')).toBe(false);
  });
});
