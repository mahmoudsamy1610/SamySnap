// Link on the clipboard as soon as recording STARTS, and the discard flow:
// stop without keeping the video → upload cancelled, Drive file deleted.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { launch, sleep, hasDisplay } from './harness.js';

const open = [];
afterEach(async () => {
  while (open.length) await open.pop().close().catch(() => {});
});
async function start(opts) {
  const h = await launch(opts);
  open.push(h);
  return h;
}
async function startRecording(h) {
  const res = await h.send('start');
  assert.equal(res.ok, true, JSON.stringify(res));
  return h.waitState((s) => s.phase === 'recording', { label: 'recording' });
}
const putsFor = (h) => h.drive.log.filter((l) => l.method === 'PUT').length;

describe('copy at start + discard', { timeout: 90_000, skip: !hasDisplay && 'needs a display' }, () => {
  test('link is on the clipboard as soon as recording starts (before Stop)', async () => {
    const h = await start();
    const s = await startRecording(h);
    const st = await h.waitState((x) => x.copiedAtStart === true, { label: 'copied at start' });
    assert.equal(st.phase, 'recording');
    assert.equal(await h.clipboard(), s.link);
  });

  test('Stop does NOT overwrite something you copied during the recording', async () => {
    const h = await start();
    await startRecording(h);
    await h.waitState((x) => x.copiedAtStart === true, { label: 'copied at start' });
    await h.page.evaluate(() => navigator.clipboard.writeText('my own text'));
    const stop = await h.send('stop');
    assert.equal(stop.ok, true);
    await h.waitState((x) => x.phase === 'done', { label: 'done' });
    assert.equal(await h.clipboard(), 'my own text');
  });

  test('discard while recording: upload cancelled, Drive file deleted, removed from history', async () => {
    const h = await start();
    await h.openNoise();
    const s = await startRecording(h);
    await h.waitState((x) => x.uploadedBytes > 0, { label: 'some data uploaded', timeout: 25_000 });
    assert.ok(h.drive.files.has(s.fileId));

    const res = await h.send('discard');
    assert.equal(res.ok, true);
    const d = await h.waitState((x) => x.phase === 'discarded', { label: 'discarded' });
    assert.equal(d.deleted, true);
    assert.equal(h.drive.files.has(s.fileId), false, 'file deleted from Drive');
    assert.equal(await h.badge(), '', 'REC badge cleared');
    const hist = (await h.local('linkHistory')) ?? [];
    assert.equal(hist.some((x) => x.fileId === s.fileId), false, 'removed from Last links');

    const puts = putsFor(h);
    await sleep(2500);
    assert.equal(putsFor(h), puts, 'no uploads after discard');
    assert.equal(h.recorderPage(), undefined, 'recorder window closed');

    // popup explains it
    await h.page.reload();
    await h.page.waitForSelector('#upload-status:not([hidden])');
    assert.match(await h.page.textContent('#upload-status'), /deleted from your Drive/);
  });

  test('discard while paused works too', async () => {
    const h = await start();
    const s = await startRecording(h);
    await h.send('pause');
    await h.waitState((x) => x.paused === true, { label: 'paused' });
    await h.send('discard');
    await h.waitState((x) => x.phase === 'discarded', { label: 'discarded' });
    assert.equal(h.drive.files.has(s.fileId), false);
  });

  test('changed your mind after Stop: "Delete this video" removes the finished upload', async () => {
    const h = await start();
    const s = await startRecording(h);
    await sleep(1500);
    await h.send('stop');
    await h.waitState((x) => x.phase === 'done', { label: 'done' });
    assert.ok(h.drive.files.get(s.fileId).data.length > 0);

    await h.page.reload();
    await h.page.waitForSelector('#discard:not([hidden])');
    assert.match(await h.page.textContent('#discard'), /Delete this video/);
    await h.page.click('#discard');
    assert.match(await h.page.textContent('#discard'), /Click again/); // asks first
    assert.ok(h.drive.files.has(s.fileId), 'not deleted after one click');
    await h.page.click('#discard');
    await h.waitState((x) => x.phase === 'discarded', { label: 'discarded' });
    assert.equal(h.drive.files.has(s.fileId), false);
  });

  test('popup during recording: two clicks on "Discard recording"; one click does nothing', async () => {
    const h = await start();
    const s = await startRecording(h);
    await h.page.reload();
    await h.page.waitForSelector('#discard:not([hidden])');
    assert.equal(await h.page.textContent('#toggle-label'), 'Stop & save');
    await h.page.click('#discard');
    await sleep(3500); // confirmation times out
    assert.equal((await h.state()).phase, 'recording');
    assert.equal(await h.page.textContent('#discard'), 'Discard recording');
    await h.page.click('#discard');
    await h.page.click('#discard');
    await h.waitState((x) => x.phase === 'discarded', { label: 'discarded' });
    assert.equal(h.drive.files.has(s.fileId), false);
  });

  test('recorder window has its own Discard button (two clicks)', async () => {
    const h = await start();
    const s = await startRecording(h);
    const rec = h.recorderPage();
    await rec.waitForSelector('#discard:not([hidden])');
    await rec.click('#discard');
    assert.match(await rec.textContent('#discard'), /Click again/);
    const closed = rec.waitForEvent('close');
    await rec.click('#discard');
    await h.waitState((x) => x.phase === 'discarded', { label: 'discarded' });
    await closed;
    assert.equal(h.drive.files.has(s.fileId), false);
  });
});
