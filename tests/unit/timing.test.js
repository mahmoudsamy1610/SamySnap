import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elapsedMs } from '../../extension/lib/timing.js';

test('not started → 0', () => {
  assert.equal(elapsedMs({}), 0);
  assert.equal(elapsedMs(null), 0);
});
test('running: now − start', () => {
  assert.equal(elapsedMs({ startedAt: 1000 }, 6000), 5000);
});
test('paused: clock stands still at pausedAt', () => {
  const s = { startedAt: 1000, paused: true, pausedAt: 4000, pausedTotalMs: 0 };
  assert.equal(elapsedMs(s, 4000), 3000);
  assert.equal(elapsedMs(s, 60_000), 3000);
});
test('resumed: paused time is excluded', () => {
  assert.equal(elapsedMs({ startedAt: 1000, paused: false, pausedTotalMs: 2000 }, 10_000), 7000);
});
test('stopped: uses stoppedAt; stopped while paused uses pausedAt', () => {
  assert.equal(elapsedMs({ startedAt: 1000, stoppedAt: 5000, pausedTotalMs: 1000 }, 99_999), 3000);
  assert.equal(elapsedMs({ startedAt: 1000, paused: true, pausedAt: 3000, stoppedAt: 9000 }, 99_999), 2000);
});
test('never negative', () => {
  assert.equal(elapsedMs({ startedAt: 5000 }, 1000), 0);
});
