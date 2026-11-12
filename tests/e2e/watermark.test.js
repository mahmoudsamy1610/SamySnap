// Built-in mark in real Chromium: always on, small, see-through white (no
// colour), bottom-right; both methods; present in the uploaded video.
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

/** Stats for a region of a frame ~0.5 s into a WebM: lit pixels, max brightness, coloured pixels. */
async function regionStats(h, bytes, region) {
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
      let lit = 0;
      let max = 0;
      let coloured = 0;
      for (let i = 0; i < d.length; i += 4) {
        const m = Math.max(d[i], d[i + 1], d[i + 2]);
        if (m > 40) lit++;
        max = Math.max(max, m);
        if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60) coloured++;
      }
      return { lit, max, coloured };
    },
    [bytes.toString('base64'), region],
  );
}

describe('built-in mark', { timeout: 90_000 }, () => {
  test('frame pipeline on a black video: only bottom-right, see-through, small, no colour', async () => {
    const h = await start();
    const r = await h.page.evaluate(async () => {
      const vf = await import('../lib/video-filter.js');
      const src = document.createElement('canvas');
      src.width = 1920;
      src.height = 1080;
      const sctx = src.getContext('2d');
      const paint = () => {
        sctx.fillStyle = '#000';
        sctx.fillRect(0, 0, 1920, 1080);
      };
      paint();
      const iv = setInterval(paint, 30);
      const srcTrack = src.captureStream(30).getVideoTracks()[0];
      const out = vf.filterTrack(srcTrack);
      const reader = new MediaStreamTrackProcessor({ track: out.track }).readable.getReader();
      const frames = [];
      for (let i = 0; i < 3; i++) frames.push((await reader.read()).value);
      const f = frames[2];
      const c = new OffscreenCanvas(f.displayWidth, f.displayHeight);
      const ctx = c.getContext('2d');
      ctx.drawImage(f, 0, 0);
      const stats = (x, y, w, hh) => {
        const d = ctx.getImageData(x, y, w, hh).data;
        let lit = 0, max = 0, minX = Infinity, minY = Infinity, coloured = 0;
        for (let i = 0; i < d.length; i += 4) {
          const m = Math.max(d[i], d[i + 1], d[i + 2]);
          if (m > 30) {
            lit++;
            const p = i / 4;
            minX = Math.min(minX, x + (p % w));
            minY = Math.min(minY, y + Math.floor(p / w));
          }
          max = Math.max(max, m);
          if (m - Math.min(d[i], d[i + 1], d[i + 2]) > 40) coloured++;
        }
        return { lit, max, minX, minY, coloured };
      };
      const res = {
        whole: stats(0, 0, 1920, 1080),
        corner: stats(1440, 900, 480, 180),
        increasing: frames[1].timestamp > frames[0].timestamp,
      };
      frames.forEach((x) => x.close());
      clearInterval(iv);
      out.stop();
      srcTrack.stop();
      return res;
    });
    assert.ok(r.increasing, 'timestamps preserved');
    assert.ok(r.corner.lit > 100, `mark drawn: ${r.corner.lit} px`);
    assert.equal(r.whole.lit, r.corner.lit, 'nothing outside the bottom-right corner');
    assert.ok(r.whole.max < 160, `see-through (max brightness ${r.whole.max} of 255)`);
    assert.equal(r.whole.coloured, 0, 'white only, no red');
    // small: the whole mark fits in roughly 180×40 px at 1080p
    assert.ok(r.whole.minX > 1920 - 200 && r.whole.minY > 1080 - 60, `box starts at ${r.whole.minX},${r.whole.minY}`);
  });

  test('always on, nothing to configure in the popup', async () => {
    const h = await start();
    await h.page.reload();
    await h.page.waitForSelector('#main-view:not([hidden])');
    assert.equal(await h.page.$('#wm-enabled'), null);
    assert.doesNotMatch(await h.page.textContent('#main-view'), /watermark/i);
  });

  for (const fallback of [false, true]) {
    test(`full recording (${fallback ? 'canvas fallback' : 'insertable streams'}): mark is in the uploaded video`, { skip: !hasDisplay && 'needs a display' }, async () => {
      const h = await start({ noInsertableStreams: fallback });
      await h.send('start');
      const s = await h.waitState((x) => x.phase === 'recording', { label: 'recording' });
      assert.equal(s.vf, fallback ? 'canvas' : 'insertable-streams');
      await sleep(2500);
      await h.send('stop');
      await h.waitState((x) => x.phase === 'done', { label: 'done' });
      const r = await regionStats(h, h.drive.fileData(s.fileId), { x: 0.88, y: 0.93 });
      assert.ok(r.lit > 40, `mark pixels: ${r.lit}`);
      assert.ok(r.max < 200, `see-through: max ${r.max}`);
      assert.ok(r.coloured < 5, `no colour: ${r.coloured}`);
    });
  }
});
