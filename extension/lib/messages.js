// Message types exchanged via chrome.runtime.sendMessage.
// `target` routes a message to one context (background / recorder / offscreen).

export const MSG = {
  // popup → background
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  START: 'start',
  STOP: 'stop',
  RETRY_UPLOAD: 'retry-upload',
  DOWNLOAD_LOCAL: 'download-local',
  RESET: 'reset',

  // recorder → background
  RECORDER_UPDATE: 'recorder-update', // { patch } merged into the shared state
  RECORDER_STOPPED: 'recorder-stopped', // user stopped via Chrome's "Stop sharing" bar / recorder button

  // background → recorder
  RECORDER_STOP: 'recorder-stop',
  RECORDER_RETRY: 'recorder-retry',
  RECORDER_DOWNLOAD: 'recorder-download',

  // background → offscreen
  OFFSCREEN_COPY: 'offscreen-copy',
};

export const TARGET = {
  background: 'background',
  recorder: 'recorder',
  offscreen: 'offscreen',
};

/** Recording lifecycle phases kept in chrome.storage.session. */
export const PHASE = {
  idle: 'idle',
  starting: 'starting', // recorder window open, picker / Drive preparation running
  recording: 'recording',
  finishing: 'finishing', // stopped, final chunk(s) uploading
  done: 'done',
  error: 'error',
};
