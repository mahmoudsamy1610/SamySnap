// Media helpers: codec choice, capture constraints and audio mixing.

import { MAX_FRAME_RATE, MAX_HEIGHT, MAX_WIDTH, VIDEO_BITS_PER_SECOND } from './constants.js';

export const MIME_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

/** First MIME type MediaRecorder supports (vp9 → vp8 → plain webm). */
export function pickMimeType(isTypeSupported = (t) => globalThis.MediaRecorder?.isTypeSupported(t)) {
  return MIME_CANDIDATES.find((t) => isTypeSupported(t)) ?? '';
}

/** MediaRecorder options for ~1080p30 at ~4 Mbps. */
export function recorderOptions(mimeType) {
  return {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond: 128_000,
  };
}

/**
 * getUserMedia constraints for a stream ID returned by
 * chrome.desktopCapture.chooseDesktopMedia (legacy "mandatory" syntax is what
 * Chrome requires for chromeMediaSource: 'desktop').
 * Capture is capped at 1920×1080 / 30 fps; a larger screen is scaled down.
 */
export function desktopConstraints(streamId, { audio = false } = {}) {
  return {
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId,
        maxWidth: MAX_WIDTH,
        maxHeight: MAX_HEIGHT,
        maxFrameRate: MAX_FRAME_RATE,
      },
    },
    audio: audio ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } } : false,
  };
}

export const MIC_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false,
};

/**
 * Combine the screen's video track with zero, one or two audio sources.
 * Two audio sources (system/tab + mic) are mixed into one track with the Web
 * Audio API because MediaRecorder only records the first audio track.
 *
 * @param {MediaStream} display  stream from desktop capture (video + optional audio)
 * @param {MediaStream|null} mic
 * @param {{AudioContext?: typeof AudioContext, MediaStream?: typeof MediaStream}} [env]
 * @returns {{stream: MediaStream, cleanup: () => void}}
 */
export function combineStreams(display, mic, env = globalThis) {
  const MS = env.MediaStream;
  const videoTracks = display.getVideoTracks();
  const audioSources = [display, mic].filter((s) => s && s.getAudioTracks().length > 0);

  if (audioSources.length <= 1) {
    const audioTracks = audioSources[0]?.getAudioTracks() ?? [];
    return { stream: new MS([...videoTracks, ...audioTracks]), cleanup: () => {} };
  }

  const ctx = new env.AudioContext();
  const dest = ctx.createMediaStreamDestination();
  for (const s of audioSources) ctx.createMediaStreamSource(s).connect(dest);
  return {
    stream: new MS([...videoTracks, ...dest.stream.getAudioTracks()]),
    cleanup: () => {
      ctx.close().catch(() => {});
    },
  };
}

/** Stop every track of the given streams. */
export function stopStreams(...streams) {
  for (const s of streams) s?.getTracks().forEach((t) => t.stop());
}
