// Exponential backoff helpers.

export const DEFAULT_RETRY = {
  maxAttempts: 8, // ~1 + 2 + 4 + 8 + 16 + 30 + 30 s ≈ 1.5 min before giving up
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

/** Delay before retry number `attempt` (1-based), with a little jitter. */
export function backoffDelay(attempt, { baseDelayMs, maxDelayMs } = DEFAULT_RETRY, random = Math.random) {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  // ±20 % jitter so parallel clients don't retry in lock-step.
  return Math.round(exp * (0.8 + random() * 0.4));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Status codes that are worth retrying (transient server / rate limit). */
export function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}
