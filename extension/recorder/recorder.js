// Recorder window: capture → MediaRecorder → stream chunks into Drive.
//
// WHY A WINDOW AND NOT THE OFFSCREEN DOCUMENT?
// getDisplayMedia() requires "transient user activation" (a click in that same
// document) and an offscreen document can never receive one, so the call fails
// there. A popup can't hold the stream either: the picker steals focus and
// Chrome closes the popup, killing the recording. So we use a small
// extension-owned window and chrome.desktopCapture.chooseDesktopMedia(), Chrome's
// native picker (Entire screen / Window / Tab + "share audio"), which needs no
// extra click. The window minimizes itself once recording starts and closes
// itself when the upload is complete.

import { TIMESLICE_MS, STORAGE } from '../lib/constants.js';
import { MSG, PHASE, TARGET } from '../lib/messages.js';
import { defaultAuthFetch } from '../lib/auth.js';
import { DriveClient } from '../lib/drive.js';
import { ResumableUploader } from '../lib/uploader.js';
import { recordingFileName, formatDuration, formatBytes } from '../lib/filename.js';
import {
  pickMimeType,
  recorderOptions,
  desktopConstraints,
  MIC_CONSTRAINTS,
  combineStreams,
  stopStreams,
} from '../lib/media.js';

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'),
  timer: $('timer'),
  link: $('link'),
  warning: $('warning'),
  error: $('error'),
  progress: $('progress'),
  stop: $('stop'),
  retry: $('retry'),
  download: $('download'),
};

const authFetch = defaultAuthFetch();
const drive = new DriveClient({ authFetch });

/** Everything about the current recording lives here (one recording per window). */
const rec = {
  fileName: recordingFileName(),
  mimeType: pickMimeType(),
  prep: null, // { fileId, link, sessionUri, shared, shareWarning }
  display: null,
  mic: null,
  cleanupAudio: () => {},
  mediaRecorder: null,
  uploader: null,
  chunks: [], // full copy of the recording, kept until Drive confirms the upload
  startedAt: 0,
  stopping: false,
  cancelled: false,
  pickerRequestId: null,
  resumeTimer: null,
  timerInterval: null,
  lastProgressSent: 0,
};
// Handy when debugging from DevTools (and used by the e2e tests).
globalThis.samysnapRecorder = rec;

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------

function report(patch) {
  return chrome.runtime
    .sendMessage({ target: TARGET.background, type: MSG.RECORDER_UPDATE, patch })
    .catch((e) => console.warn('report failed', e));
}

function setStatus(text) {
  ui.status.textContent = text;
  document.title = `SamySnap – ${text}`;
}

function showError(text) {
  ui.error.textContent = text || '';
  ui.error.hidden = !text;
}

function showWarning(text) {
  ui.warning.textContent = text || '';
  ui.warning.hidden = !text;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/** Chrome's native picker. Resolves {streamId, canRequestAudioTrack} or null if cancelled. */
function chooseSource() {
  return new Promise((resolve) => {
    rec.pickerRequestId = chrome.desktopCapture.chooseDesktopMedia(
      ['screen', 'window', 'tab', 'audio'], // "screen" first = whole desktop is the default tab
      (streamId, options) => {
        rec.pickerRequestId = null;
        resolve(streamId ? { streamId, canRequestAudioTrack: Boolean(options?.canRequestAudioTrack) } : null);
      },
    );
  });
}

async function getDisplayStream({ streamId, canRequestAudioTrack }) {
  try {
    return await navigator.mediaDevices.getUserMedia(desktopConstraints(streamId, { audio: canRequestAudioTrack }));
  } catch (err) {
    if (!canRequestAudioTrack) throw err;
    // Some platforms offer audio but fail to open it – record video only rather than nothing.
    showWarning('System/tab audio could not be captured; recording without it.');
    return navigator.mediaDevices.getUserMedia(desktopConstraints(streamId, { audio: false }));
  }
}

async function getSettings() {
  return (await chrome.storage.local.get(STORAGE.settings))[STORAGE.settings] ?? { mic: false };
}

async function start() {
  setStatus('Preparing Google Drive…');
  const settings = await getSettings();

  // Drive preparation (file → share + session) runs WHILE the picker is open.
  // MediaRecorder only starts once both are ready, so the order required by
  // the design (file, link, session, THEN record) is preserved.
  const prepPromise = drive.prepareRecordingFile(rec.fileName);
  prepPromise.catch(() => {}); // handled below

  setStatus('Choose what to share…');
  const source = await chooseSource();
  if (!source || rec.cancelled) return cancel(prepPromise);

  try {
    rec.display = await getDisplayStream(source);
    if (settings.mic) {
      try {
        rec.mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      } catch (err) {
        showWarning(`Microphone unavailable (${err.name}); recording without it.`);
      }
    }
  } catch (err) {
    stopStreams(rec.display, rec.mic);
    return fail(`Could not capture the screen: ${err.message || err.name}`, prepPromise);
  }

  setStatus('Preparing Google Drive…');
  try {
    rec.prep = await prepPromise;
  } catch (err) {
    stopStreams(rec.display, rec.mic);
    return fail(`Google Drive error: ${err.message}`);
  }
  if (rec.cancelled) return cancel(Promise.resolve(rec.prep));

  beginRecording();
}

function beginRecording() {
  const { stream, cleanup } = combineStreams(rec.display, rec.mic);
  rec.cleanupAudio = cleanup;

  rec.uploader = new ResumableUploader({
    sessionUri: rec.prep.sessionUri,
    fetch: authFetch,
    onProgress: onUploadProgress,
    onError: onUploadError,
  });

  const mr = new MediaRecorder(stream, recorderOptions(rec.mimeType));
  rec.mediaRecorder = mr;
  mr.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    rec.chunks.push(e.data); // local safety copy
    rec.uploader.append(e.data);
  };
  mr.onstop = finishUpload;
  mr.onerror = (e) => {
    console.error('MediaRecorder error', e.error);
    showError(`Recorder error: ${e.error?.message || e.error?.name || 'unknown'}`);
    stop('recorder');
  };

  // Chrome's own "Stop sharing" bar ends the video track → same as Stop.
  rec.display.getVideoTracks()[0]?.addEventListener('ended', () => stop('recorder'));

  mr.start(TIMESLICE_MS);
  rec.startedAt = Date.now();

  ui.link.textContent = rec.prep.link;
  ui.link.href = rec.prep.link;
  ui.stop.disabled = false;
  ui.stop.textContent = 'Stop';
  if (rec.prep.shareWarning) showWarning(rec.prep.shareWarning);
  setStatus('Recording');
  startTimer();

  report({
    phase: PHASE.recording,
    startedAt: rec.startedAt,
    fileId: rec.prep.fileId,
    fileName: rec.fileName,
    link: rec.prep.link,
    shared: rec.prep.shared,
    warning: rec.prep.shareWarning || ui.warning.textContent || null,
    mimeType: rec.mimeType,
    uploadedBytes: 0,
    totalBytes: 0,
    error: null,
    stopHandled: false,
  });

  // Get out of the way: the recording keeps going while minimized.
  chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { state: 'minimized' })).catch(() => {});
}

function startTimer() {
  const tick = () => (ui.timer.textContent = formatDuration(Date.now() - rec.startedAt));
  tick();
  rec.timerInterval = setInterval(tick, 500);
}

// ---------------------------------------------------------------------------
// Stop / finish
// ---------------------------------------------------------------------------

/**
 * @param {'background'|'recorder'} source  who asked. When the recorder itself
 * stops (Chrome's "Stop sharing" bar, the Stop button here) it tells the
 * background first so the link is copied immediately.
 */
function stop(source) {
  if (!rec.mediaRecorder) {
    // Still in the picker / preparing → cancel.
    rec.cancelled = true;
    if (rec.pickerRequestId !== null) chrome.desktopCapture.cancelChooseDesktopMedia(rec.pickerRequestId);
    return;
  }
  if (rec.stopping) return;
  rec.stopping = true;

  if (source !== 'background') {
    chrome.runtime.sendMessage({ target: TARGET.background, type: MSG.RECORDER_STOPPED }).catch(() => {});
  }

  clearInterval(rec.timerInterval);
  ui.stop.disabled = true;
  setStatus('Finishing upload…');
  if (rec.mediaRecorder.state !== 'inactive') rec.mediaRecorder.stop(); // emits last dataavailable, then onstop
  stopStreams(rec.display, rec.mic);
  rec.cleanupAudio();
}

async function finishUpload() {
  // NOTE: the 'finishing' phase is set by the background when it handles the
  // stop (after copying the link). Reporting it from here could race ahead and
  // make the background think the stop was already handled.
  clearTimeout(rec.resumeTimer);
  try {
    await rec.uploader.finish();
    onUploadComplete();
  } catch (err) {
    onFinalFailure(err);
  }
}

function onUploadComplete() {
  clearTimeout(rec.resumeTimer);
  rec.chunks = []; // Drive has everything – release memory
  setStatus('Done ✓');
  showError('');
  ui.retry.hidden = true;
  ui.download.hidden = true;
  report({ phase: PHASE.done, uploadedBytes: rec.uploader.offset, totalBytes: rec.uploader.appended, error: null });
  setTimeout(() => window.close(), 1500);
}

function onUploadProgress({ uploadedBytes, totalBytes }) {
  ui.progress.textContent = `Uploaded ${formatBytes(uploadedBytes)} of ${formatBytes(totalBytes)}`;
  const now = Date.now();
  if (now - rec.lastProgressSent > 1000) {
    rec.lastProgressSent = now;
    report({ uploadedBytes, totalBytes });
  }
}

/** Uploader gave up after its retries. */
function onUploadError(err) {
  console.warn('Upload error', err);
  if (!rec.stopping) {
    // Still recording: keep recording (chunks are buffered) and retry periodically.
    showWarning(`Upload paused (${err.message}). Still recording; retrying automatically…`);
    report({ warning: 'Upload paused – network problem. Retrying automatically.' });
    scheduleResume();
  }
}

function scheduleResume() {
  clearTimeout(rec.resumeTimer);
  rec.resumeTimer = setTimeout(() => {
    if (rec.uploader.completed) return;
    showWarning(rec.prep.shareWarning || '');
    rec.uploader.resume().catch(() => {}); // onError fires again if it still fails
  }, 30_000);
}

window.addEventListener('online', () => {
  if (rec.uploader?.error) {
    clearTimeout(rec.resumeTimer);
    if (rec.stopping) retryUpload();
    else rec.uploader.resume().catch(() => {});
  }
});

/** Final upload failed – never lose the video: offer Retry and Download. */
function onFinalFailure(err) {
  setStatus('Upload failed');
  showError(`${err.message}. Your recording is safe in this window – retry or download it.`);
  ui.retry.hidden = false;
  ui.download.hidden = false;
  report({ phase: PHASE.error, error: err.message, canRetry: true, canDownload: true });
  chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { state: 'normal', focused: true })).catch(() => {});
}

async function retryUpload() {
  if (!rec.uploader || rec.uploader.completed) return;
  setStatus('Retrying upload…');
  showError('');
  ui.retry.hidden = true;
  report({ phase: PHASE.finishing, error: null });
  try {
    await rec.uploader.resume();
    onUploadComplete();
  } catch (err) {
    onFinalFailure(err);
  }
}

function downloadLocal() {
  if (rec.chunks.length === 0) return;
  const blob = new Blob(rec.chunks, { type: rec.mimeType || 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = rec.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------
// Cancel / early failure
// ---------------------------------------------------------------------------

async function cancel(prepPromise) {
  setStatus('Cancelled');
  stopStreams(rec.display, rec.mic);
  // Remove the empty Drive file we created for nothing.
  try {
    const prep = await prepPromise;
    await drive.deleteFile(prep.fileId);
  } catch {
    /* preparation failed or delete failed – nothing useful to do */
  }
  await report({ phase: PHASE.idle, windowId: null });
  window.close();
}

async function fail(message, prepPromise) {
  setStatus('Could not start');
  showError(message);
  ui.stop.hidden = true;
  if (prepPromise) {
    prepPromise.then((p) => drive.deleteFile(p.fileId)).catch(() => {});
  }
  await report({ phase: PHASE.error, error: message, canDownload: false, canRetry: false });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== TARGET.recorder) return false;
  if (msg.type === MSG.RECORDER_STOP) stop('background');
  else if (msg.type === MSG.RECORDER_RETRY) retryUpload();
  else if (msg.type === MSG.RECORDER_DOWNLOAD) downloadLocal();
  return false;
});

ui.stop.addEventListener('click', () => stop('recorder'));
ui.retry.addEventListener('click', retryUpload);
ui.download.addEventListener('click', downloadLocal);

// Closing this window while recording/uploading would lose data → ask first.
window.addEventListener('beforeunload', (e) => {
  const unfinished = rec.mediaRecorder && !rec.uploader?.completed;
  if (unfinished) {
    e.preventDefault();
    e.returnValue = '';
  }
});

start().catch((err) => fail(`Unexpected error: ${err.message || err}`));
