/**
 * Simple in-memory rate limiter, used for the login form and for chat messages.
 *
 * Per process, so it resets on restart and does not add up across replicas. For
 * the login form that is acceptable — the window is short and the point is to
 * make guessing slow. For messages it is a cost ceiling, not a guarantee. A
 * shared limit would have to live in Postgres.
 */
export interface RateLimiter {
  /** Returns false when the key is over its limit. */
  take(key: string): boolean;
}

export function createRateLimiter(maxAttempts: number, windowMs: number): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    take(key) {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);

      if (recent.length >= maxAttempts) {
        hits.set(key, recent);
        return false;
      }

      recent.push(now);
      hits.set(key, recent);

      // Clean up so the map does not grow without bound on many unique keys.
      if (hits.size > 5000) {
        for (const [existingKey, timestamps] of hits) {
          if (timestamps.every((at) => now - at >= windowMs)) hits.delete(existingKey);
        }
      }

      return true;
    },
  };
}
