// Screenshot → clipboard: capture the current tab, copy the PNG via the small
// focused "Screenshot copied" window, which then closes itself.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { launch, sleep } from './harness.js';

const open = [];
afterEach(async () => {
  while (open.length) await open.pop().close().catch(() => {});
});
async function start(opts) {
  const h = await launch(opts);
  open.push(h);
  return h;
}

/** Read the clipboard image (from an extension page) → {width, height, blueish}. */
async function clipboardImage(h) {
  await h.page.bringToFront();
  return h.page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find((i) => i.types.includes('image/png'));
    if (!item) return { types: items.map((i) => i.types) };
    const bmp = await createImageBitmap(await item.getType('image/png'));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const [r, g, b] = ctx.getImageData(5, bmp.height - 5, 1, 1).data;
    return { width: bmp.width, height: bmp.height, pixel: [r, g, b] };
  });
}

describe('screenshot', { timeout: 60_000 }, () => {
  test('captures the current tab and puts the PNG on the clipboard; toast closes itself', async () => {
    const h = await start({ siteAccess: true });
    const web = await h.ctx.newPage();
    await web.goto('https://bug.example.test/');
    await web.bringToFront();
    const res = await h.send('screenshot');
    assert.equal(res.ok, true, JSON.stringify(res));

    // toast window appears and reports success
    let toast;
    for (let i = 0; i < 30 && !toast; i++) {
      toast = h.ctx.pages().find((p) => p.url().includes('/shot/shot.html'));
      if (!toast) await sleep(100);
    }
    assert.ok(toast, 'toast window opened');
    await toast.waitForFunction(() => document.getElementById('status').textContent.includes('copied'));

    const img = await clipboardImage(h);
    assert.ok(img.width > 300 && img.height > 200, JSON.stringify(img));
    const [r, g, b] = img.pixel;
    assert.ok(b > 180 && r < 80, `captured the blue bug page, got ${img.pixel}`);

    // the screenshot is not kept in storage
    const pending = await h.page.evaluate(async () => (await chrome.storage.session.get('pendingScreenshot')).pendingScreenshot);
    assert.equal(pending, undefined);

    // closes by itself
    await sleep(2800);
    assert.equal(h.ctx.pages().some((p) => p.url().includes('/shot/shot.html')), false, 'toast closed');
  });

  test('page Chrome does not allow (chrome://) → friendly notification, no crash', async () => {
    const h = await start({ siteAccess: true });
    const web = await h.ctx.newPage();
    await web.goto('chrome://version/');
    await web.bringToFront();
    // Spy on notifications (the virtual test screen has no notification daemon).
    await h.sw.evaluate(() => {
      globalThis.__notes = [];
      const orig = chrome.notifications.create.bind(chrome.notifications);
      chrome.notifications.create = (id, opts, ...rest) => {
        globalThis.__notes.push({ id, title: opts?.title });
        return orig(id, opts, ...rest);
      };
    });
    const res = await h.send('screenshot');
    assert.equal(res.ok, false);
    const notes = await h.sw.evaluate(() => globalThis.__notes);
    assert.deepEqual(notes.map((n) => n.id), ['samysnap-shot']);
    assert.match(notes[0].title, /Can’t screenshot this page/);
    assert.equal(h.ctx.pages().some((p) => p.url().includes('/shot/')), false, 'no toast on failure');
  });

  test('shortcut registered and popup has a Screenshot button', async () => {
    const h = await start();
    const cmds = await h.page.evaluate(() => chrome.commands.getAll());
    assert.ok(cmds.find((c) => c.name === 'take-screenshot'));
    await h.page.reload();
    await h.page.waitForSelector('#main-view:not([hidden])');
    assert.equal(await h.page.isVisible('#screenshot'), true);
    assert.match(await h.page.getAttribute('#screenshot', 'title'), /clipboard/);
  });
});
