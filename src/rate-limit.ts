/**
 * Simple in-memory rate limiter for the login form.
 * One instance per process is enough: the app runs as a single Railway service
 * with a local SQLite file, so there is no shared state between replicas.
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
