// Recording time that excludes paused periods.

/**
 * @param {{startedAt?: number, paused?: boolean, pausedAt?: number, pausedTotalMs?: number, stoppedAt?: number}} s
 * @param {number} [now]
 * @returns {number} milliseconds actually recorded
 */
export function elapsedMs(s, now = Date.now()) {
  if (!s?.startedAt) return 0;
  // While paused (or stopped while paused) the clock stands still at pausedAt.
  const end = s.paused && s.pausedAt ? s.pausedAt : s.stoppedAt || now;
  return Math.max(0, end - s.startedAt - (s.pausedTotalMs || 0));
}
