import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWatermark,
  formatTimestamp,
  layoutWatermark,
  drawWatermark,
  canWatermark,
  POSITIONS,
  WATERMARK_DEFAULTS,
} from '../../extension/lib/watermark.js';

describe('normalizeWatermark', () => {
  test('defaults: off, "SamySnap", bottom-right, with date/time', () => {
    assert.deepEqual(normalizeWatermark(undefined), { ...WATERMARK_DEFAULTS });
  });
  test('sanitizes text (trim, collapse spaces, max 60 chars) and position', () => {
    const w = normalizeWatermark({ enabled: 1, text: '  Acme   QA\nteam ', position: 'middle', timestamp: 0 });
    assert.deepEqual(w, { enabled: true, text: 'Acme QA team', position: 'bottom-right', timestamp: false });
    assert.equal(normalizeWatermark({ text: 'x'.repeat(100) }).text.length, 60);
  });
  test('keeps valid positions', () => {
    for (const p of POSITIONS) assert.equal(normalizeWatermark({ position: p }).position, p);
  });
});

test('formatTimestamp', () => {
  assert.equal(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05');
});

describe('layoutWatermark', () => {
  const base = { width: 1920, height: 1080, lines: 2, textWidth: 300 };
  test('stays inside the frame in every corner', () => {
    for (const position of POSITIONS) {
      const L = layoutWatermark({ ...base, position });
      assert.ok(L.box.x >= 0 && L.box.y >= 0, position);
      assert.ok(L.box.x + L.box.w <= 1920 && L.box.y + L.box.h <= 1080, position);
    }
  });
  test('goes to the requested corner', () => {
    const br = layoutWatermark({ ...base, position: 'bottom-right' });
    const tl = layoutWatermark({ ...base, position: 'top-left' });
    assert.ok(br.box.x > 960 && br.box.y > 540);
    assert.ok(tl.box.x < 960 && tl.box.y < 540);
  });
  test('scales with resolution (readable but small: ~2.6 % of height)', () => {
    assert.equal(layoutWatermark({ ...base, position: 'top-left' }).fontSize, 28);
    assert.equal(layoutWatermark({ ...base, height: 720, width: 1280, position: 'top-left' }).fontSize, 19);
    assert.equal(layoutWatermark({ ...base, height: 200, width: 300, position: 'top-left' }).fontSize, 12); // floor
  });
  test('logo only (no text lines)', () => {
    const L = layoutWatermark({ ...base, lines: 0, textWidth: 0, position: 'top-left' });
    assert.equal(L.box.w, L.logo.size);
  });
});

describe('drawWatermark', () => {
  function fakeCtx() {
    const calls = [];
    return {
      calls,
      save: () => calls.push(['save']),
      restore: () => calls.push(['restore']),
      measureText: (t) => ({ width: t.length * 10 }),
      drawImage: (...a) => calls.push(['drawImage', ...a.slice(1)]),
      fillText: (t, x, y) => calls.push(['fillText', t, x, y]),
      set font(v) { calls.push(['font', v]); },
      set fillStyle(v) {},
      set globalAlpha(v) {},
      set shadowColor(v) {},
      set shadowBlur(v) {},
      set textBaseline(v) {},
    };
  }
  test('draws logo, text and timestamp, and restores the context', () => {
    const ctx = fakeCtx();
    drawWatermark(ctx, { width: 1920, height: 1080, text: 'Acme', timestampText: '2026-01-01 10:00:00', position: 'bottom-right', logo: {} });
    const texts = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
    assert.deepEqual(texts, ['Acme', '2026-01-01 10:00:00']);
    assert.equal(ctx.calls.filter((c) => c[0] === 'drawImage').length, 1);
    assert.equal(ctx.calls.at(-1)[0], 'restore');
  });
  test('empty text and no timestamp → logo only', () => {
    const ctx = fakeCtx();
    drawWatermark(ctx, { width: 1280, height: 720, text: '', timestampText: '', position: 'top-left', logo: {} });
    assert.equal(ctx.calls.filter((c) => c[0] === 'fillText').length, 0);
    assert.equal(ctx.calls.filter((c) => c[0] === 'drawImage').length, 1);
  });
});

test('canWatermark feature detection', () => {
  assert.equal(canWatermark({}), false);
  const ok = { MediaStreamTrackProcessor: 1, MediaStreamTrackGenerator: 1, VideoFrame: 1, OffscreenCanvas: 1 };
  assert.equal(canWatermark(ok), true);
});
