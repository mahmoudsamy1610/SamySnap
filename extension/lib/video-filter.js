// Frame filter applied to every recorded video frame.
//
// How: Chrome's insertable streams (MediaStreamTrackProcessor → TransformStream
// → MediaStreamTrackGenerator) when available, otherwise a canvas fallback
// driven by a worker timer. Both keep frame timing and keep running while the
// recorder window is minimized.

const LABEL = String.fromCharCode(83, 97, 109, 121, 83, 110, 97, 112);
const ALPHA = 0.42;

/**
 * Pure layout math (unit-tested): small mark + label in the bottom-right corner.
 * @param {{width: number, height: number, textWidth: number}} p
 */
export function layoutMark({ width, height, textWidth }) {
  const fontSize = Math.max(10, Math.round(height * 0.016)); // ~17 px at 1080p
  const size = Math.round(fontSize * 1.3);
  const gap = Math.round(fontSize * 0.45);
  const margin = Math.round(Math.min(width, height) * 0.018);
  const boxW = size + gap + textWidth;
  const x = width - margin - boxW;
  const y = height - margin - size;
  return {
    fontSize,
    mark: { x, y, size },
    text: { x: x + size + gap, y: y + size / 2 },
    box: { x, y, w: boxW, h: size },
  };
}

/** Outline mark: corner brackets + ring + dot, white, see-through. */
function strokeMark(ctx, { x, y, size }) {
  const lw = Math.max(1, size * 0.085);
  const k = size * 0.3; // bracket arm length
  const p = lw / 2;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  // top-left, top-right, bottom-right, bottom-left brackets
  ctx.moveTo(x + p, y + k); ctx.lineTo(x + p, y + p); ctx.lineTo(x + k, y + p);
  ctx.moveTo(x + size - k, y + p); ctx.lineTo(x + size - p, y + p); ctx.lineTo(x + size - p, y + k);
  ctx.moveTo(x + size - p, y + size - k); ctx.lineTo(x + size - p, y + size - p); ctx.lineTo(x + size - k, y + size - p);
  ctx.moveTo(x + k, y + size - p); ctx.lineTo(x + p, y + size - p); ctx.lineTo(x + p, y + size - k);
  ctx.stroke();
  const cx = x + size / 2;
  const cy = y + size / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.08, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Paint the mark onto a 2D context of size width×height.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 */
export function paintMark(ctx, { width, height }) {
  const probe = layoutMark({ width, height, textWidth: 0 });
  ctx.save();
  ctx.font = `400 ${probe.fontSize}px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
  const L = layoutMark({ width, height, textWidth: Math.ceil(ctx.measureText(LABEL).width) });
  ctx.globalAlpha = ALPHA;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; // keeps it legible on white backgrounds
  ctx.shadowBlur = Math.max(1, Math.round(L.fontSize * 0.15));
  strokeMark(ctx, L.mark);
  ctx.textBaseline = 'middle';
  ctx.fillText(LABEL, L.text.x, L.text.y);
  ctx.restore();
  return L;
}

/** Insertable streams available on this page? (preferred method) */
export function canFilterInsertable(env = globalThis) {
  return Boolean(env.MediaStreamTrackProcessor && env.MediaStreamTrackGenerator && env.VideoFrame && env.OffscreenCanvas);
}

/** Canvas fallback available? */
export function canFilterCanvas(env = globalThis) {
  return Boolean(env.HTMLCanvasElement?.prototype?.captureStream && env.Worker);
}

/**
 * Insertable-streams filter.
 * @returns {{track: MediaStreamTrack, method: string, stop: () => void}}
 */
export function filterTrack(track) {
  const processor = new MediaStreamTrackProcessor({ track });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  let canvas = null;
  let ctx = null;
  let errored = false;

  const paint = (frame) => {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h); // window captures can change size
      ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    }
    ctx.drawImage(frame, 0, 0, w, h);
    paintMark(ctx, { width: w, height: h });
    return new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
  };

  const transformer = new TransformStream({
    transform(frame, controller) {
      try {
        controller.enqueue(paint(frame));
        frame.close();
      } catch (err) {
        // Never freeze the video: pass the original frame through.
        if (!errored) console.warn('frame filter failed', err);
        errored = true;
        controller.enqueue(frame);
      }
    },
  });

  processor.readable.pipeThrough(transformer).pipeTo(generator.writable).catch(() => {});
  return { track: generator, method: 'insertable-streams', stop: () => generator.stop() };
}

/**
 * Canvas fallback: <video> → <canvas> (+ mark) → captureStream(), pulled by a
 * worker timer (page timers and rAF are throttled in a minimized window).
 * @returns {Promise<{track: MediaStreamTrack, method: string, stop: () => void}>}
 */
export async function filterTrackCanvas(track, { tickerUrl, fps = 30 } = {}) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  const outTrack = canvas.captureStream(0).getVideoTracks()[0];

  const draw = () => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    paintMark(ctx, { width: w, height: h });
    outTrack.requestFrame?.();
  };
  draw();

  const worker = new Worker(tickerUrl);
  worker.onmessage = draw;
  worker.postMessage({ fps });

  return {
    track: outTrack,
    method: 'canvas',
    stop() {
      worker.terminate();
      outTrack.stop();
      video.srcObject = null;
    },
  };
}

/** Best available method. */
export async function createFilteredTrack(track, { tickerUrl, env = globalThis } = {}) {
  if (canFilterInsertable(env)) return filterTrack(track);
  if (canFilterCanvas(env)) return filterTrackCanvas(track, { tickerUrl });
  throw new Error('frame processing unavailable');
}
