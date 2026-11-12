// Burn a watermark (logo + text + optional live date/time) into the video.
//
// How: Chrome's "insertable streams" (MediaStreamTrackProcessor →
// TransformStream → MediaStreamTrackGenerator). Every captured frame is drawn
// on an OffscreenCanvas, the watermark is painted on top, and a new VideoFrame
// with the SAME timestamp goes to the recorder. Unlike a <video> + canvas +
// requestAnimationFrame loop, this keeps running while the recorder window is
// minimized (rAF stops in hidden windows).

export const POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

export const WATERMARK_DEFAULTS = Object.freeze({
  enabled: false,
  text: 'SamySnap',
  position: 'bottom-right',
  timestamp: true,
});

const MAX_TEXT = 60;

/** Merge saved settings with defaults and sanitize them. */
export function normalizeWatermark(saved) {
  const w = { ...WATERMARK_DEFAULTS, ...(saved || {}) };
  return {
    enabled: Boolean(w.enabled),
    text: String(w.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT),
    position: POSITIONS.includes(w.position) ? w.position : WATERMARK_DEFAULTS.position,
    timestamp: Boolean(w.timestamp),
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** "2026-11-12 14:03:09" in local time. */
export function formatTimestamp(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Pure layout math (unit-tested): where the watermark box goes.
 * @param {{width: number, height: number, position: string, lines: number, textWidth: number}} p
 */
export function layoutWatermark({ width, height, position, lines, textWidth }) {
  const fontSize = Math.max(12, Math.round(height * 0.026)); // ~28 px at 1080p
  const lineHeight = Math.round(fontSize * 1.3);
  const logo = lines > 0 ? Math.round(lineHeight * Math.min(lines, 2) * 0.95) : Math.round(fontSize * 1.6);
  const gap = Math.round(fontSize * 0.5);
  const margin = Math.round(Math.min(width, height) * 0.025);
  const boxW = logo + (lines > 0 ? gap + textWidth : 0);
  const boxH = Math.max(logo, lines * lineHeight);
  const right = position.endsWith('right');
  const bottom = position.startsWith('bottom');
  const x = right ? width - margin - boxW : margin;
  const y = bottom ? height - margin - boxH : margin;
  return {
    fontSize,
    lineHeight,
    logo: { x, y: y + Math.round((boxH - logo) / 2), size: logo },
    text: { x: x + logo + gap, y: y + Math.round((boxH - lines * lineHeight) / 2) },
    box: { x, y, w: boxW, h: boxH },
  };
}

/**
 * Paint the watermark onto a 2D context of size width×height.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {{width: number, height: number, text: string, timestampText?: string, position: string, logo?: CanvasImageSource}} o
 */
export function drawWatermark(ctx, { width, height, text, timestampText, position, logo }) {
  const lines = [text, timestampText].filter(Boolean);
  const probe = layoutWatermark({ width, height, position, lines: lines.length, textWidth: 0 });
  ctx.save();
  ctx.font = `600 ${probe.fontSize}px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
  const textWidth = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
  const L = layoutWatermark({ width, height, position, lines: lines.length, textWidth: Math.ceil(textWidth) });

  ctx.globalAlpha = 0.85;
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = Math.max(2, Math.round(L.fontSize * 0.25));
  if (logo) ctx.drawImage(logo, L.logo.x, L.logo.y, L.logo.size, L.logo.size);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, L.text.x, L.text.y + i * L.lineHeight + Math.round(L.fontSize * 0.12)));
  ctx.restore();
  return L;
}

/** True when this Chrome can process video frames (insertable streams). */
export function canWatermark(env = globalThis) {
  return Boolean(env.MediaStreamTrackProcessor && env.MediaStreamTrackGenerator && env.VideoFrame && env.OffscreenCanvas);
}

/**
 * Wrap a video track so every frame carries the watermark.
 * @param {MediaStreamTrack} track  source video track (screen capture)
 * @param {{text: string, position: string, timestamp: boolean}} opts
 * @param {{logo?: ImageBitmap, now?: () => Date}} [extra]
 * @returns {{track: MediaStreamTrack, stop: () => void}}
 */
export function watermarkTrack(track, opts, { logo, now = () => new Date() } = {}) {
  const processor = new MediaStreamTrackProcessor({ track });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  let canvas = null;
  let ctx = null;
  let lastSecond = -1;
  let stamp = '';

  const transformer = new TransformStream({
    transform(frame, controller) {
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (!canvas || canvas.width !== w || canvas.height !== h) {
        canvas = new OffscreenCanvas(w, h); // window captures can change size
        ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      }
      ctx.drawImage(frame, 0, 0, w, h);
      if (opts.timestamp) {
        const d = now();
        const s = Math.floor(d.getTime() / 1000);
        if (s !== lastSecond) {
          lastSecond = s;
          stamp = formatTimestamp(d);
        }
      }
      drawWatermark(ctx, {
        width: w,
        height: h,
        text: opts.text,
        timestampText: opts.timestamp ? stamp : '',
        position: opts.position,
        logo,
      });
      const out = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
      frame.close();
      controller.enqueue(out);
    },
  });

  const pipe = processor.readable.pipeThrough(transformer).pipeTo(generator.writable);
  pipe.catch(() => {}); // ends when the source track stops

  return {
    track: generator,
    stop() {
      generator.stop();
    },
  };
}

/** Load the SamySnap logo as an ImageBitmap (best effort). */
export async function loadLogo(url) {
  try {
    const res = await fetch(url);
    return await createImageBitmap(await res.blob());
  } catch {
    return undefined;
  }
}
