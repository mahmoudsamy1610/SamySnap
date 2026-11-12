import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { layoutMark, paintMark, canFilterInsertable, canFilterCanvas, createFilteredTrack } from '../../extension/lib/video-filter.js';

describe('layoutMark', () => {
  test('small: ~1.6 % of the height (17 px at 1080p), minimum 10 px', () => {
    assert.equal(layoutMark({ width: 1920, height: 1080, textWidth: 80 }).fontSize, 17);
    assert.equal(layoutMark({ width: 1280, height: 720, textWidth: 80 }).fontSize, 12);
    assert.equal(layoutMark({ width: 320, height: 240, textWidth: 80 }).fontSize, 10);
  });
  test('bottom-right corner, inside the frame', () => {
    const L = layoutMark({ width: 1920, height: 1080, textWidth: 80 });
    assert.ok(L.box.x > 1700 && L.box.y > 1000, JSON.stringify(L.box));
    assert.ok(L.box.x + L.box.w <= 1920 && L.box.y + L.box.h <= 1080);
  });
});

describe('paintMark', () => {
  function fakeCtx() {
    const calls = [];
    const set = (k) => (v) => calls.push([k, v]);
    return {
      calls,
      save: () => calls.push(['save']),
      restore: () => calls.push(['restore']),
      measureText: (t) => ({ width: t.length * 9 }),
      beginPath() {}, moveTo() {}, lineTo() {}, arc() {},
      stroke: () => calls.push(['stroke']),
      fill: () => calls.push(['fill']),
      drawImage: () => calls.push(['drawImage']),
      fillText: (t) => calls.push(['fillText', t]),
      set font(v) { set('font')(v); },
      set globalAlpha(v) { set('globalAlpha')(v); },
      set fillStyle(v) { set('fillStyle')(v); },
      set strokeStyle(v) { set('strokeStyle')(v); },
      set shadowColor(v) {}, set shadowBlur(v) {}, set lineWidth(v) {}, set lineCap(v) {}, set lineJoin(v) {}, set textBaseline(v) {},
    };
  }
  test('see-through white outline mark + light label, no images, no colour', () => {
    const ctx = fakeCtx();
    paintMark(ctx, { width: 1920, height: 1080 });
    const alpha = ctx.calls.find((c) => c[0] === 'globalAlpha')[1];
    assert.ok(alpha > 0.2 && alpha < 0.6, `alpha ${alpha}`);
    assert.deepEqual(ctx.calls.filter((c) => c[0] === 'fillStyle' || c[0] === 'strokeStyle').map((c) => c[1]), ['#ffffff', '#ffffff']);
    assert.equal(ctx.calls.filter((c) => c[0] === 'drawImage').length, 0, 'drawn with lines, not a bitmap logo');
    assert.ok(ctx.calls.filter((c) => c[0] === 'stroke').length >= 2);
    assert.match(ctx.calls.find((c) => c[0] === 'font')[1], /^400 /, 'light weight');
    const label = ctx.calls.find((c) => c[0] === 'fillText')[1];
    assert.equal(label, 'SamySnap');
    assert.equal(ctx.calls.at(-1)[0], 'restore');
  });
});

describe('feature detection', () => {
  const insertable = { MediaStreamTrackProcessor: 1, MediaStreamTrackGenerator: 1, VideoFrame: 1, OffscreenCanvas: 1 };
  const canvas = { HTMLCanvasElement: { prototype: { captureStream() {} } }, Worker: function () {} };
  test('insertable streams / canvas fallback', () => {
    assert.equal(canFilterInsertable(insertable), true);
    assert.equal(canFilterInsertable({ ...insertable, MediaStreamTrackGenerator: undefined }), false);
    assert.equal(canFilterCanvas(canvas), true);
    assert.equal(canFilterCanvas({}), false);
  });
  test('clear error when neither method exists', async () => {
    await assert.rejects(createFilteredTrack({}, { env: {} }), /unavailable/);
  });
});

test('the label is not stored as plain text in the source', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../extension/lib/video-filter.js', import.meta.url), 'utf8');
  assert.ok(!src.includes("'SamySnap'") && !src.includes('"SamySnap"'));
});
