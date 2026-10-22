'use strict';

function createRateLimiter(options = {}) {
  const enabled = options.enabled !== false;
  const buckets = new Map();
  let lastCleanup = 0;

  function check(key, limit, windowMs, now = Date.now()) {
    if (!enabled) return { allowed: true, retryAfter: 0 };
    if (now - lastCleanup > windowMs) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
      lastCleanup = now;
    }
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    current.count += 1;
    if (current.count > limit) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
      };
    }
    return { allowed: true, retryAfter: 0 };
  }

  return { check };
}

module.exports = { createRateLimiter };
