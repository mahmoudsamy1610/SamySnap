import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { recordingFileName, screenshotFileName, formatDuration, formatBytes } from '../../extension/lib/filename.js';
import { upsertHistory, patchHistory } from '../../extension/lib/history.js';
import { backoffDelay, isRetryableStatus } from '../../extension/lib/retry.js';
import { driveViewLink, CHUNK_ALIGN } from '../../extension/lib/constants.js';

describe('filename', () => {
  test('bug-YYYY-MM-DD_HH-mm-ss.webm with zero padding', () => {
    assert.equal(recordingFileName(new Date(2026, 0, 2, 3, 4, 5)), 'bug-2026-01-02_03-04-05.webm');
    assert.equal(recordingFileName(new Date(2026, 11, 31, 23, 59, 59)), 'bug-2026-12-31_23-59-59.webm');
  });
  test('screenshot-YYYY-MM-DD_HH-mm-ss.png', () => {
    assert.equal(screenshotFileName(new Date(2026, 0, 2, 3, 4, 5)), 'screenshot-2026-01-02_03-04-05.png');
  });
  test('formatDuration', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(65_400), '1:05');
    assert.equal(formatDuration(3_725_000), '1:02:05');
    assert.equal(formatDuration(-5), '0:00');
  });
  test('formatBytes', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  });
});

describe('constants', () => {
  test('view link format', () => {
    assert.equal(driveViewLink('abc'), 'https://drive.google.com/file/d/abc/view');
  });
  test('alignment is 256 KiB', () => {
    assert.equal(CHUNK_ALIGN, 262144);
  });
});

describe('history', () => {
  const e = (id, extra = {}) => ({ fileId: id, link: `l${id}`, ...extra });
  test('newest first, capped at 5', () => {
    let list = [];
    for (let i = 1; i <= 7; i++) list = upsertHistory(list, e(i));
    assert.deepEqual(list.map((x) => x.fileId), [7, 6, 5, 4, 3]);
  });
  test('upsert merges an existing entry and moves it to the top', () => {
    const list = upsertHistory([e(1, { status: 'recording' }), e(2)], e(2, { status: 'done' }));
    assert.deepEqual(list.map((x) => x.fileId), [2, 1]);
    assert.equal(list[0].status, 'done');
  });
  test('patch updates in place', () => {
    const list = patchHistory([e(1), e(2)], 2, { status: 'failed' });
    assert.deepEqual(list.map((x) => [x.fileId, x.status]), [[1, undefined], [2, 'failed']]);
  });
  test('handles undefined lists', () => {
    assert.deepEqual(upsertHistory(undefined, e(1)), [e(1)]);
    assert.deepEqual(patchHistory(undefined, 1, {}), []);
  });
});

describe('retry', () => {
  const cfg = { baseDelayMs: 1000, maxDelayMs: 30_000 };
  test('exponential and capped (no jitter at random=0.5)', () => {
    const r = () => 0.5;
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((a) => backoffDelay(a, cfg, r)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
  test('jitter stays within ±20 %', () => {
    assert.equal(backoffDelay(1, cfg, () => 0), 800);
    assert.equal(backoffDelay(1, cfg, () => 1), 1200);
  });
  test('retryable statuses', () => {
    for (const s of [408, 429, 500, 502, 503, 504]) assert.ok(isRetryableStatus(s), String(s));
    for (const s of [400, 401, 403, 404, 410]) assert.ok(!isRetryableStatus(s), String(s));
  });
});
