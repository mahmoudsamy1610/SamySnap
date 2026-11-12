// Watermark in real Chromium: the frame pipeline itself (pixel-exact on a
// synthetic black video) and the full recording flow (logo pixels present in
// the uploaded video only when enabled).
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

/** Count "logo red" pixels in a region of the first decoded frame of a WebM. */
async function redPixelsInVideo(h, bytes, region) {
  return h.page.evaluate(
    async ([b64, region]) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const v = document.createElement('video');
      v.muted = true;
      v.src = URL.createObjectURL(new Blob([bin], { type: 'video/webm' }));
      await new Promise((res, rej) => {
        v.onloadeddata = res;
        v.onerror = () => rej(new Error('video error'));
      });
      // The very first decoded frame can be blank – play ~0.5 s in and grab that.
      await v.play();
      await new Promise((res) => {
        const check = () => (v.currentTime > 0.5 ? res() : setTimeout(check, 50));
        check();
      });
      v.pause();
      const c = new OffscreenCanvas(v.videoWidth, v.videoHeight);
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0);
      const x = Math.round(region.x * v.videoWidth);
      const y = Math.round(region.y * v.videoHeight);
      const d = ctx.getImageData(x, y, v.videoWidth - x, v.videoHeight - y).data;
      let red = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 110 && d[i + 2] < 110) red++;
      return { red, width: v.videoWidth, height: v.videoHeight };
    },
    [bytes.toString('base64'), region],
  );
}

describe('watermark', { timeout: 90_000 }, () => {
  test('frame pipeline: draws exactly in the chosen corner, keeps size and frame timing', async () => {
    const h = await start();
    const result = await h.page.evaluate(async () => {
      const wm = await import('../lib/watermark.js');
      // synthetic black 1280x720 source
      const src = document.createElement('canvas');
      src.width = 1280;
      src.height = 720;
      const sctx = src.getContext('2d');
      const paint = () => {
        sctx.fillStyle = '#000';
        sctx.fillRect(0, 0, 1280, 720);
      };
      paint();
      const iv = setInterval(paint, 30);
      const srcTrack = src.captureStream(30).getVideoTracks()[0];
      const logo = await wm.loadLogo('/icons/icon128.png');
      const out = wm.watermarkTrack(srcTrack, { text: 'Acme QA', position: 'bottom-right', timestamp: true }, { logo });
      const reader = new MediaStreamTrackProcessor({ track: out.track }).readable.getReader();
      const frames = [];
      for (let i = 0; i < 3; i++) frames.push((await reader.read()).value);
      const f = frames[2];
      const c = new OffscreenCanvas(f.displayWidth, f.displayHeight);
      const ctx = c.getContext('2d');
      ctx.drawImage(f, 0, 0);
      const bright = (x, y, w, hh) => {
        const d = ctx.getImageData(x, y, w, hh).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 300) n++;
        return n;
      };
      const r = {
        size: [f.displayWidth, f.displayHeight],
        increasing: frames[1].timestamp > frames[0].timestamp && frames[2].timestamp > frames[1].timestamp,
        bottomRight: bright(640, 540, 640, 180),
        topLeft: bright(0, 0, 640, 360),
        topRight: bright(640, 0, 640, 360),
        bottomLeft: bright(0, 360, 640, 360),
      };
      frames.forEach((x) => x.close());
      clearInterval(iv);
      out.stop();
      srcTrack.stop();
      return r;
    });
    assert.deepEqual(result.size, [1280, 720], 'resolution unchanged');
    assert.ok(result.increasing, 'timestamps preserved');
    assert.ok(result.bottomRight > 200, `watermark pixels in bottom-right: ${result.bottomRight}`);
    assert.equal(result.topLeft, 0);
    assert.equal(result.topRight, 0);
    assert.equal(result.bottomLeft, 0);
  });

  test('popup: enabling shows options and saves them', async () => {
    const h = await start();
    await h.page.reload();
    await h.page.waitForSelector('#main-view:not([hidden])');
    assert.equal(await h.page.isHidden('#wm-options'), true);
    await h.page.check('#wm-enabled');
    assert.equal(await h.page.isVisible('#wm-options'), true);
    await h.page.fill('#wm-text', 'Acme   QA');
    await h.page.selectOption('#wm-position', 'top-left');
    await h.page.uncheck('#wm-timestamp');
    await sleep(500);
    const s = await h.local('settings');
    assert.deepEqual(s.watermark, { enabled: true, text: 'Acme QA', position: 'top-left', timestamp: false });
    await h.page.reload();
    await h.page.waitForSelector('#main-view:not([hidden])');
    assert.equal(await h.page.inputValue('#wm-text'), 'Acme QA');
    assert.equal(await h.page.inputValue('#wm-position'), 'top-left');
  });

  test('full recording: logo burned into the uploaded video only when enabled', { skip: !hasDisplay && 'needs a display' }, async () => {
    const results = {};
    for (const enabled of [true, false]) {
      const h = await start();
      await h.page.evaluate(
        (en) => chrome.storage.local.set({ settings: { watermark: { enabled: en, text: 'Acme QA', position: 'bottom-right', timestamp: true } } }),
        enabled,
      );
      await h.send('start');
      const s = await h.waitState((x) => x.phase === 'recording', { label: 'recording' });
      assert.equal(s.watermark, enabled);
      await sleep(2500);
      await h.send('stop');
      await h.waitState((x) => x.phase === 'done', { label: 'done' });
      results[enabled] = await redPixelsInVideo(h, h.drive.fileData(s.fileId), { x: 0.75, y: 0.8 });
      await h.close();
      open.pop();
    }
    assert.ok(results.true.red > 50, `logo pixels with watermark: ${results.true.red}`);
    assert.ok(results.false.red < 5, `logo pixels without: ${results.false.red}`);
  });
});
