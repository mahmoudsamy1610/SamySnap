import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ResumableUploader, UploadError, parseRangeHeader } from '../../extension/lib/uploader.js';
import { FakeDrive, ALIGN, randomBytes } from '../helpers/fake-drive.js';

const KiB = 1024;
const noSleep = async () => {};

/** Create a fake drive with one empty file + open session, like prepareRecordingFile does. */
async function setup({ delayMs = 0, retry } = {}) {
  const drive = new FakeDrive();
  const fetch = drive.asFetch({ delayMs });
  const authed = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer tok-1' } });
  const create = await authed(`${drive.base}/drive/v3/files`, { method: 'POST', body: JSON.stringify({ name: 'x.webm' }) });
  const { id } = await create.json();
  const s = await authed(`${drive.base}/upload/drive/v3/files/${id}?uploadType=resumable`, { method: 'PATCH', body: '{}' });
  const sessionUri = s.headers.get('Location');
  drive.log.length = 0;
  const progress = [];
  const errors = [];
  const up = new ResumableUploader({
    sessionUri,
    fetch: authed,
    sleep: noSleep,
    retry: retry ?? { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1 },
    onProgress: (p) => progress.push(p),
    onError: (e) => errors.push(e),
  });
  return { drive, up, fileId: id, progress, errors };
}

/** Feed `data` into the uploader in chunks of the given sizes (cycled). */
function feed(up, data, sizes) {
  let pos = 0;
  let i = 0;
  while (pos < data.length) {
    const n = Math.min(sizes[i++ % sizes.length], data.length - pos);
    up.append(new Blob([data.subarray(pos, pos + n)]));
    pos += n;
  }
}

const chunkPuts = (drive) => drive.log.filter((l) => l.method === 'PUT');

describe('parseRangeHeader', () => {
  test('parses bytes=0-N', () => {
    assert.equal(parseRangeHeader('bytes=0-262143'), 262144);
  });
  test('missing header means nothing received', () => {
    assert.equal(parseRangeHeader(null), 0);
  });
  test('garbage throws', () => {
    assert.throws(() => parseRangeHeader('weird'), UploadError);
  });
});

describe('ResumableUploader – happy path', () => {
  test('streams 256 KiB-aligned chunks while recording and the rest on finish', async () => {
    const { drive, up, fileId } = await setup();
    const data = randomBytes(3 * ALIGN + 100 * KiB, 7);
    feed(up, data, [100 * KiB, 300 * KiB, 50 * KiB]);
    const meta = await up.finish();

    assert.deepEqual(drive.fileData(fileId), data);
    assert.equal(meta.id, fileId);
    const puts = chunkPuts(drive);
    // All but the last are open-ended (/*) and aligned.
    for (const p of puts.slice(0, -1)) {
      assert.match(p.contentRange, /\/\*$/);
      assert.equal(p.bodySize % ALIGN, 0);
    }
    // The final chunk declares the total and continues exactly where the last one ended.
    const final = /bytes (\d+)-(\d+)\/(\d+)/.exec(puts.at(-1).contentRange);
    assert.ok(final, 'final chunk has a total');
    assert.equal(Number(final[3]), data.length);
    assert.equal(Number(final[2]), data.length - 1);
    assert.equal(Number(final[1]) % ALIGN, 0);
  });

  test('sends nothing until 256 KiB is buffered', async () => {
    const { drive, up } = await setup();
    up.append(new Blob([randomBytes(ALIGN - 1)]));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(chunkPuts(drive).length, 0);
    assert.equal(up.bufferedBytes, ALIGN - 1);
  });

  test('recording smaller than 256 KiB is sent as a single final chunk', async () => {
    const { drive, up, fileId } = await setup();
    const data = randomBytes(1000);
    up.append(new Blob([data]));
    await up.finish();
    assert.deepEqual(drive.fileData(fileId), data);
    assert.deepEqual(chunkPuts(drive).map((p) => p.contentRange), ['bytes 0-999/1000']);
  });

  test('exact multiple of 256 KiB finishes with "bytes */TOTAL"', async () => {
    const { drive, up, fileId } = await setup({ delayMs: 1 });
    const data = randomBytes(2 * ALIGN);
    up.append(new Blob([data]));
    // let the aligned chunk go out first
    await new Promise((r) => setTimeout(r, 20));
    await up.finish();
    assert.deepEqual(drive.fileData(fileId), data);
    assert.equal(chunkPuts(drive).at(-1).contentRange, `bytes */${2 * ALIGN}`);
  });

  test('empty recording completes with "bytes */0"', async () => {
    const { drive, up, fileId } = await setup();
    await up.finish();
    assert.equal(drive.fileData(fileId).length, 0);
    assert.deepEqual(chunkPuts(drive).map((p) => p.contentRange), ['bytes */0']);
  });

  test('only one request in flight at a time, in order', async () => {
    const { drive, up, fileId } = await setup({ delayMs: 3 });
    const data = randomBytes(6 * ALIGN + 5);
    feed(up, data, [ALIGN, ALIGN / 2, 2 * ALIGN]);
    await up.finish();
    assert.equal(drive.maxInflight, 1);
    assert.deepEqual(drive.fileData(fileId), data);
    // starts strictly increasing
    const starts = chunkPuts(drive).map((p) => Number(/bytes (\d+)-/.exec(p.contentRange)?.[1] ?? -1)).filter((n) => n >= 0);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  });

  test('reports progress up to the full size', async () => {
    const { up, progress } = await setup();
    const data = randomBytes(ALIGN + 10);
    up.append(new Blob([data]));
    await up.finish();
    const last = progress.at(-1);
    assert.equal(last.uploadedBytes, data.length);
    assert.equal(last.totalBytes, data.length);
  });

  test('append() after finish() throws', async () => {
    const { up } = await setup();
    up.finish();
    assert.throws(() => up.append(new Blob(['x'])), UploadError);
  });
});

describe('ResumableUploader – failures and resume', () => {
  test('retries a 503 after querying status with "bytes */*"', async () => {
    const { drive, up, fileId } = await setup();
    drive.fault(503);
    const data = randomBytes(ALIGN + 1);
    up.append(new Blob([data]));
    await up.finish();
    assert.deepEqual(drive.fileData(fileId), data);
    assert.ok(chunkPuts(drive).some((p) => p.contentRange === 'bytes */*'), 'status query sent');
  });

  test('network drop AFTER Drive stored the chunk: resumes from Range, no duplicate bytes', async () => {
    const { drive, up, fileId } = await setup();
    drive.fault('network-after');
    const data = randomBytes(3 * ALIGN + 17);
    feed(up, data, [ALIGN]);
    await up.finish();
    assert.deepEqual(drive.fileData(fileId), data);
  });

  test('network drop BEFORE Drive got anything: re-sends the same range', async () => {
    const { drive, up, fileId } = await setup();
    drive.fault('network');
    const data = randomBytes(2 * ALIGN + 3);
    feed(up, data, [ALIGN]);
    await up.finish();
    assert.deepEqual(drive.fileData(fileId), data);
    const fromZero = chunkPuts(drive).filter((p) => /^bytes 0-/.test(p.contentRange || ''));
    assert.equal(fromZero.length, 2, 'data from byte 0 sent again after the drop');
  });

  test('final chunk stored but response lost: status query reveals completion', async () => {
    const { drive, up, fileId } = await setup();
    const data = randomBytes(5000);
    up.append(new Blob([data]));
    drive.fault('status-after:503');
    await up.finish();
    assert.deepEqual(drive.fileData(fileId), data);
  });

  test('Drive persisting fewer bytes than sent: trusts Range and re-sends the rest', async () => {
    const { drive, up, fileId } = await setup();
    let first = true;
    drive.partialPersist = (len) => {
      if (first) {
        first = false;
        return len - ALIGN; // keep one 256 KiB block less
      }
      return len;
    };
    const data = randomBytes(4 * ALIGN + 99);
    up.append(new Blob([data.subarray(0, 3 * ALIGN)]));
    up.append(new Blob([data.subarray(3 * ALIGN)]));
    await up.finish();
    assert.deepEqual(drive.fileData(fileId), data);
  });

  test('non-retryable error (session expired, 404) fails fast and calls onError', async () => {
    const { drive, up, errors } = await setup();
    drive.fault(404);
    up.append(new Blob([randomBytes(ALIGN)]));
    await assert.rejects(up.finish(), (e) => e instanceof UploadError && e.status === 404);
    assert.equal(errors.length, 1);
    assert.equal(chunkPuts(drive).length, 1, 'no retries for 404');
  });

  test('gives up after maxAttempts, then resume() finishes the upload', async () => {
    const { drive, up, fileId, errors } = await setup({ retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
    // 3 attempts + 2 status queries in between = 5 failing requests
    drive.fault('network', { times: 5 });
    const data = randomBytes(ALIGN + 42);
    up.append(new Blob([data]));
    await assert.rejects(up.finish(), UploadError);
    assert.equal(errors.length, 1);
    assert.ok(up.error);

    await up.resume();
    assert.deepEqual(drive.fileData(fileId), data);
    assert.equal(up.completed, true);
  });

  test('upload failing mid-recording keeps buffering; finish() retries everything', async () => {
    const { drive, up, fileId, errors } = await setup({ retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } });
    drive.fault('network', { times: 3 });
    const data = randomBytes(5 * ALIGN + 1);
    up.append(new Blob([data.subarray(0, ALIGN)]));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(errors.length, 1, 'gave up while still recording');
    up.append(new Blob([data.subarray(ALIGN)])); // recording continues
    await up.finish();
    assert.deepEqual(drive.fileData(fileId), data);
  });

  test('401 is passed through as a fatal error when the fetch wrapper cannot fix it', async () => {
    const drive = new FakeDrive();
    const up = new ResumableUploader({ sessionUri: `${drive.base}/upload/session/nope`, fetch: drive.asFetch(), sleep: noSleep });
    await assert.rejects(up.finish(), (e) => e.status === 401);
  });
});
