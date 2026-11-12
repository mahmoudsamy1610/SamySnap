// Browser end-to-end tests: the REAL extension in REAL Chromium, recording the
// (virtual) screen with MediaRecorder and streaming into a fake Google Drive.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { launch, sleep, hasDisplay } from './harness.js';
import { ALIGN } from '../helpers/fake-drive.js';
import { extensionIdFromKey } from '../../scripts/generate-key.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DIR } from './harness.js';

const manifest = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8'));
const needsDisplay = { timeout: 90_000, skip: hasDisplay ? false : 'needs a display – run `npm run test:e2e` (uses xvfb on Linux)' };
const open = [];
afterEach(async () => {
  while (open.length) await open.pop().close().catch(() => {});
});
async function start(opts) {
  const h = await launch(opts);
  open.push(h);
  return h;
}

/** Start recording and wait until MediaRecorder runs. */
async function startRecording(h) {
  const res = await h.send('start');
  assert.equal(res.ok, true, JSON.stringify(res));
  return h.waitState((s) => s.phase === 'recording', { label: 'recording' });
}

/** Play the uploaded bytes in a <video> element: proves it is a valid video. */
async function probeVideo(h, bytes) {
  return h.page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(new Blob([bin], { type: 'video/webm' }));
    await new Promise((res, rej) => {
      v.onloadeddata = res;
      v.onerror = () => rej(new Error(`video error ${v.error?.code}`));
    });
    return { width: v.videoWidth, height: v.videoHeight };
  }, bytes.toString('base64'));
}

describe('extension basics', { timeout: 60_000 }, () => {
  test('loads with the stable ID derived from manifest "key"', async () => {
    const h = await start({ configured: false });
    assert.equal(h.extId, extensionIdFromKey(manifest.key));
  });

  test('fresh install: popup offers the setup guide instead of Record', async () => {
    const h = await start({ configured: false });
    await h.page.reload();
    await h.page.waitForSelector('#setup-view:not([hidden])');
    assert.equal(await h.page.textContent('#open-setup'), 'Start setup');
    assert.equal(await h.page.isHidden('#main-view'), true);
    assert.equal(await h.page.isHidden('#connect-view'), true);
  });

  test('start/stop command is registered (Alt+Shift+R when Chrome assigns it)', async () => {
    const h = await start({ configured: false });
    const cmds = await h.page.evaluate(() => chrome.commands.getAll());
    const c = cmds.find((x) => x.name === 'toggle-recording');
    assert.ok(c, 'command registered');
    assert.equal(c.description, 'Start / stop recording');
    // Chrome leaves the suggested key unassigned when it conflicts with another
    // shortcut, or for extensions loaded via --load-extension (as in this test).
    // Users can then set it at chrome://extensions/shortcuts.
    if (c.shortcut) assert.match(c.shortcut, /Alt\+Shift\+R|⌥⇧R/);
  });

  test('signed in: popup shows Record, mic off by default, empty history', async () => {
    const h = await start();
    await h.page.reload();
    await h.page.waitForSelector('#main-view:not([hidden])');
    assert.equal(await h.page.textContent('#toggle-label'), 'Record');
    assert.equal(await h.page.isChecked('#mic'), false);
    assert.equal(await h.page.isVisible('#history-empty'), true);
  });
});

describe('recording → Drive', needsDisplay, () => {
  test('full flow: link before recording, chunks during, link on clipboard at Stop, valid video after', async () => {
    const h = await start();
    await h.openNoise();
    const s = await startRecording(h);

    // a) file + public permission + session existed before recording started
    assert.match(s.link, /^https:\/\/drive\.google\.com\/file\/d\/[^/]+\/view$/);
    assert.equal(s.shared, true);
    assert.match(s.mimeType, /vp9|vp8/);
    const file = h.drive.files.get(s.fileId);
    assert.equal(file.name, s.fileName);
    assert.match(file.name, /^bug-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.webm$/);
    assert.deepEqual(file.permissions, [{ type: 'anyone', role: 'reader', allowFileDiscovery: false }]);
    const folder = h.drive.files.get(file.parents[0]);
    assert.equal(folder.name, 'Bug Recordings');

    // badge shows REC
    assert.equal(await h.badge(), 'REC');

    // b) chunks stream up WHILE recording, aligned to 256 KiB
    await h.waitState((x) => x.uploadedBytes > 0, { label: 'mid-recording upload', timeout: 25_000 });
    const midPuts = h.drive.log.filter((l) => l.method === 'PUT' && l.contentRange?.endsWith('/*') && l.bodySize > 0);
    assert.ok(midPuts.length >= 1, 'at least one intermediate chunk');
    for (const p of midPuts) assert.equal(p.bodySize % ALIGN, 0);

    // c) Stop → link already on the clipboard when stop returns
    const stop = await h.send('stop');
    assert.equal(stop.ok, true);
    assert.equal(stop.copied, true);
    assert.equal(await h.clipboard(), s.link);

    // d) final chunk completes the SAME file; it is a playable WebM
    const done = await h.waitState((x) => x.phase === 'done', { label: 'done' });
    assert.equal(done.uploadedBytes, done.totalBytes);
    const bytes = h.drive.fileData(s.fileId);
    assert.equal(bytes.length, done.totalBytes);
    assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3', 'EBML/WebM header');
    const finalPut = h.drive.log.filter((l) => l.method === 'PUT').at(-1);
    assert.match(finalPut.contentRange, new RegExp(`/${bytes.length}$`));
    const video = await probeVideo(h, bytes);
    assert.ok(video.width > 0 && video.width <= 1920, `width ${video.width}`);
    assert.ok(video.height > 0 && video.height <= 1080, `height ${video.height}`);

    // e) badge cleared, history updated, recorder window closed itself
    assert.equal(await h.badge(), '');
    const hist = await h.local('linkHistory');
    assert.equal(hist[0].link, s.link);
    assert.equal(hist[0].status, 'done');
    await sleep(2500);
    assert.equal(h.recorderPage(), undefined, 'recorder window closed');
  });

  test('Chrome "Stop sharing" bar (video track ended) behaves exactly like Stop', async () => {
    const h = await start();
    const s = await startRecording(h);
    const rec = h.recorderPage();
    await rec.evaluate(() => {
      const t = globalThis.samysnapRecorder.display.getVideoTracks()[0];
      t.stop();
      t.dispatchEvent(new Event('ended')); // what Chrome fires when the user clicks "Stop sharing"
    });
    const after = await h.waitState((x) => x.phase === 'finishing' || x.phase === 'done', { label: 'stopped' });
    assert.equal(after.copied, true);
    assert.equal(await h.clipboard(), s.link);
    await h.waitState((x) => x.phase === 'done', { label: 'done' });
  });

  test('microphone option mixes an Opus audio track into the recording', async () => {
    const h = await start();
    await h.page.reload();
    await h.page.waitForSelector('#main-view:not([hidden])');
    await h.page.check('#mic');
    await sleep(200);
    assert.deepEqual(await h.local('settings'), { mic: true });
    const s = await startRecording(h);
    await sleep(2500);
    await h.send('stop');
    await h.waitState((x) => x.phase === 'done', { label: 'done' });
    const bytes = h.drive.fileData(s.fileId);
    assert.ok(bytes.includes(Buffer.from('A_OPUS')), 'WebM has an Opus audio track');
  });

  test('without mic (and no system audio on this OS) the recording is video-only', async () => {
    const h = await start();
    const s = await startRecording(h);
    await sleep(2500);
    await h.send('stop');
    await h.waitState((x) => x.phase === 'done', { label: 'done' });
    assert.ok(!h.drive.fileData(s.fileId).includes(Buffer.from('A_OPUS')));
  });

  test('popup during recording: Stop button, running timer; after: history with working Copy', async () => {
    const h = await start();
    await startRecording(h);
    await h.page.reload();
    await h.page.waitForSelector('#main-view:not([hidden])');
    assert.equal(await h.page.textContent('#toggle-label'), 'Stop & copy link');
    const t1 = await h.page.textContent('#timer');
    await sleep(1600);
    const t2 = await h.page.textContent('#timer');
    assert.notEqual(t1, t2, 'timer advances');

    await h.page.click('#toggle'); // real click on Stop
    await h.waitState((x) => x.phase === 'done', { label: 'done' });
    await h.page.waitForSelector('#history li');
    assert.match(await h.page.textContent('#upload-status'), /Upload complete/);
    await h.page.evaluate(() => navigator.clipboard.writeText('something else'));
    await h.page.click('#history li .copy');
    const s = await h.state();
    assert.equal(await h.clipboard(), s.link);
  });

  test('sharing blocked by an admin → private link still copied, clear warning shown', async () => {
    const h = await start();
    h.drive.shareBlocked = true;
    const s = await startRecording(h);
    assert.equal(s.shared, false);
    assert.match(s.warning, /blocked/i);
    await h.page.reload();
    await h.page.waitForSelector('#warning:not([hidden])');
    assert.match(await h.page.textContent('#warning'), /admin/);
    await h.send('stop');
    assert.equal(await h.clipboard(), s.link);
    await h.waitState((x) => x.phase === 'done', { label: 'done' });
  });

  test('upload fails for good → error + "Download video" saves the recording locally', async () => {
    const h = await start();
    const s = await startRecording(h);
    h.drive.fault(410, { times: 50 }); // session gone – not retryable
    await sleep(2500);
    await h.send('stop');
    const err = await h.waitState((x) => x.phase === 'error', { label: 'error' });
    assert.equal(err.canDownload, true);
    assert.equal(err.canRetry, true);
    assert.equal(await h.badge(), '!');
    assert.equal((await h.local('linkHistory'))[0].status, 'failed');

    const rec = h.recorderPage();
    await rec.waitForSelector('#download:not([hidden])');
    const [download] = await Promise.all([rec.waitForEvent('download'), rec.click('#download')]);
    assert.equal(download.suggestedFilename(), s.fileName);
    const path = await download.path();
    const local = readFileSync(path);
    assert.equal(local.subarray(0, 4).toString('hex'), '1a45dfa3');
    assert.ok(local.length > 1000);
  });

  test('transient network failures during the upload are retried transparently', async () => {
    const h = await start();
    await h.openNoise();
    const s = await startRecording(h);
    h.drive.fault('network', { times: 1 });
    h.drive.fault(503, { times: 1 });
    await sleep(5000);
    await h.send('stop');
    const done = await h.waitState((x) => x.phase === 'done', { label: 'done', timeout: 30_000 });
    assert.equal(h.drive.fileData(s.fileId).length, done.totalBytes);
    assert.ok(h.drive.log.some((l) => l.contentRange === 'bytes */*'), 'resumed via status query');
  });
});
