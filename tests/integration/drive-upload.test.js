// End-to-end of the Drive pipeline over REAL HTTP (Node's fetch → a local fake
// Drive server that enforces the resumable protocol):
//   prepareRecordingFile → stream chunks while "recording" → stop → finalize,
// including token expiry (401), dropped connections and 5xx.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DriveClient } from '../../extension/lib/drive.js';
import { ResumableUploader } from '../../extension/lib/uploader.js';
import { createAuthFetch } from '../../extension/lib/auth.js';
import { STORAGE } from '../../extension/lib/constants.js';
import { FakeDrive, ALIGN, randomBytes, memoryStore } from '../helpers/fake-drive.js';

let drive;
let base;

before(async () => {
  drive = new FakeDrive({ validTokens: ['good-1', 'good-2'] });
  base = await drive.listen();
});
after(() => drive.close());

/** chrome.identity stand-in: hands out tokens, supports removing cached ones. */
function tokenSource(tokens) {
  const queue = [...tokens];
  const removed = [];
  return {
    removed,
    getToken: async () => queue[0],
    removeToken: async (t) => {
      removed.push(t);
      if (queue[0] === t) queue.shift();
    },
  };
}

function client(tokens) {
  const ts = tokenSource(tokens);
  const authFetch = createAuthFetch({ getToken: ts.getToken, removeToken: ts.removeToken });
  const store = memoryStore();
  const dc = new DriveClient({ authFetch, store, apiBase: `${base}/drive/v3`, uploadBase: `${base}/upload/drive/v3` });
  return { dc, authFetch, ts, store };
}

/** Simulate MediaRecorder: irregular chunks every few ms. */
async function simulateRecording(up, data, sizes, gapMs = 2) {
  let pos = 0;
  let i = 0;
  while (pos < data.length) {
    const n = Math.min(sizes[i++ % sizes.length], data.length - pos);
    up.append(new Blob([data.subarray(pos, pos + n)]));
    pos += n;
    await new Promise((r) => setTimeout(r, gapMs));
  }
}

describe('Drive pipeline over HTTP', () => {
  test('link exists before recording; Stop → final chunk completes the same file', async () => {
    const { dc, authFetch, store } = client(['good-1']);
    const prep = await dc.prepareRecordingFile('bug-test.webm');
    assert.equal(prep.link, `https://drive.google.com/file/d/${prep.fileId}/view`);
    assert.ok(store.map.get(STORAGE.folderId));

    const up = new ResumableUploader({ sessionUri: prep.sessionUri, fetch: authFetch, sleep: async () => {} });
    const data = randomBytes(5 * ALIGN + 123_456, 3);
    await simulateRecording(up, data, [180_000, 333_333, 90_000]);

    // While recording, most of the data is already on the server.
    assert.ok(up.offset >= 4 * ALIGN, `uploaded during recording: ${up.offset}`);
    const meta = await up.finish();
    assert.equal(meta.id, prep.fileId);
    assert.deepEqual(drive.fileData(prep.fileId), data);
    assert.equal(drive.maxInflight, 1);
  });

  test('real fetch returns 308 (no Location) as a response instead of following it', async () => {
    const { dc, authFetch } = client(['good-1']);
    const prep = await dc.prepareRecordingFile('a.webm');
    const res = await authFetch(prep.sessionUri, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes 0-${ALIGN - 1}/*` },
      body: new Blob([randomBytes(ALIGN)]),
    });
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('Range'), `bytes=0-${ALIGN - 1}`);
  });

  test('expired token: 401 → cached token removed → retried with the new token', async () => {
    const { dc, authFetch, ts } = client(['expired', 'good-2']);
    const prep = await dc.prepareRecordingFile('b.webm');
    assert.deepEqual(ts.removed, ['expired']);
    const up = new ResumableUploader({ sessionUri: prep.sessionUri, fetch: authFetch, sleep: async () => {} });
    up.append(new Blob([randomBytes(ALIGN + 1)]));
    await up.finish();
    assert.equal(drive.fileData(prep.fileId).length, ALIGN + 1);
  });

  test('dropped TCP connections and 5xx mid-upload are survived without corrupting the file', async () => {
    const { dc, authFetch } = client(['good-1']);
    const prep = await dc.prepareRecordingFile('c.webm');
    drive.fault('network');
    drive.fault('network-after');
    drive.fault(503);
    drive.fault('status-after:502');
    const up = new ResumableUploader({
      sessionUri: prep.sessionUri,
      fetch: authFetch,
      sleep: async () => {},
      retry: { maxAttempts: 10, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const data = randomBytes(7 * ALIGN + 999, 11);
    await simulateRecording(up, data, [ALIGN, 100_000, 2 * ALIGN]);
    await up.finish();
    assert.deepEqual(drive.fileData(prep.fileId), data);
  });

  test('second recording reuses the cached folder', async () => {
    const { dc, store } = client(['good-1']);
    const a = await dc.prepareRecordingFile('d1.webm');
    const b = await dc.prepareRecordingFile('d2.webm');
    const folder = store.map.get(STORAGE.folderId);
    assert.deepEqual(drive.files.get(a.fileId).parents, [folder]);
    assert.deepEqual(drive.files.get(b.fileId).parents, [folder]);
  });
});
