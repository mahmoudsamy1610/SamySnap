// Message types exchanged via chrome.runtime.sendMessage.
// `target` routes a message to one context (background / recorder / offscreen).

export const MSG = {
  // popup → background
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  START: 'start',
  STOP: 'stop',
  PAUSE: 'pause',
  SCREENSHOT: 'screenshot',
  RESUME: 'resume',
  RETRY_UPLOAD: 'retry-upload',
  DOWNLOAD_LOCAL: 'download-local',
  RESET: 'reset',
  STATUS: 'status', // → {configured, connected, redirectUri, ...}

  // setup wizard → background
  SAVE_CLIENT_ID: 'save-client-id',
  RESET_SETUP: 'reset-setup',
  OPEN_SETUP: 'open-setup',

  // recorder → background
  RECORDER_UPDATE: 'recorder-update', // { patch } merged into the shared state
  RECORDER_STOPPED: 'recorder-stopped', // user stopped via Chrome's "Stop sharing" bar / recorder button

  // background → recorder
  RECORDER_STOP: 'recorder-stop',
  RECORDER_PAUSE: 'recorder-pause',
  RECORDER_RESUME: 'recorder-resume',
  RECORDER_RETRY: 'recorder-retry',
  RECORDER_DOWNLOAD: 'recorder-download',

  // background → offscreen
  OFFSCREEN_COPY: 'offscreen-copy',
  OFFSCREEN_COPY_IMAGE: 'offscreen-copy-image',
};

export const TARGET = {
  background: 'background',
  recorder: 'recorder',
  offscreen: 'offscreen',
};

/**
 * Only accept messages from our own extension pages. (No website or other
 * extension can reach us today – there are no content scripts and no
 * externally_connectable – this is defence in depth.)
 */
export function isFromThisExtension(sender, runtimeId = globalThis.chrome?.runtime?.id) {
  if (!sender || !runtimeId || sender.id !== runtimeId) return false;
  // Our pages, offscreen document and service worker all live on our own origin.
  return !sender.url || sender.url.startsWith(`chrome-extension://${runtimeId}/`);
}

/** Recording lifecycle phases kept in chrome.storage.session. */
export const PHASE = {
  idle: 'idle',
  starting: 'starting', // recorder window open, picker / Drive preparation running
  recording: 'recording',
  finishing: 'finishing', // stopped, final chunk(s) uploading
  done: 'done',
  error: 'error',
};
