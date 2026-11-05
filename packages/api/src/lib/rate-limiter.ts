/**
 * In-memory token-bucket rate limiter.
 *
 * Each key gets its own bucket. A bucket holds up to `capacity` tokens and
 * refills at `refillPerSec` tokens per second (fractional refills allowed).
 * `tryAcquire` refills lazily based on wall-clock elapsed time since the
 * last touch, caps at `capacity`, then consumes one token if available.
 *
 * This is intentionally process-local and non-persistent. It is suitable
 * for single-node deployments and best-effort abuse protection. For a
 * horizontally scaled deployment, swap in a shared store (e.g. Redis)
 * behind the same `RateLimiter` interface.
 */
export interface RateLimiter {
  tryAcquire(key: string): boolean;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimiterOptions {
  capacity: number;
  refillPerSec: number;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  if (opts.capacity <= 0) {
    throw new Error('capacity must be > 0');
  }
  if (opts.refillPerSec <= 0) {
    throw new Error('refillPerSec must be > 0');
  }

  const buckets = new Map<string, Bucket>();

  return {
    tryAcquire(key: string): boolean {
      const now = Date.now();
      let bucket = buckets.get(key);

      if (!bucket) {
        bucket = { tokens: opts.capacity, lastRefillMs: now };
        buckets.set(key, bucket);
      } else {
        const elapsedMs = now - bucket.lastRefillMs;
        if (elapsedMs > 0) {
          const refill = (elapsedMs / 1000) * opts.refillPerSec;
          bucket.tokens = Math.min(opts.capacity, bucket.tokens + refill);
          bucket.lastRefillMs = now;
        }
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return true;
      }
      return false;
    },
  };
}
