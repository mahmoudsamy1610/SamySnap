// Service worker: the coordinator.
//
// It cannot record or touch the clipboard itself (no DOM in MV3 service
// workers), so it:
//   * opens the recorder window (recorder/recorder.html) that captures + uploads,
//   * keeps the shared state in chrome.storage.session (survives SW restarts),
//   * copies the link via the offscreen document the instant Stop happens,
//   * owns the badge, notifications, keyboard shortcut and the link history.

import { STORAGE } from './lib/constants.js';
import { MSG, PHASE, TARGET } from './lib/messages.js';
import { upsertHistory, patchHistory } from './lib/history.js';
import { defaultAuth, defaultAuthFetch, AuthError, isValidClientId, cleanClientId } from './lib/auth.js';
import { DriveClient } from './lib/drive.js';

const ACTIVE_PHASES = new Set([PHASE.starting, PHASE.recording, PHASE.finishing]);
const NOTIFY_STOP = 'samysnap-stopped';
const NOTIFY_FAIL = 'samysnap-failed';

// ---------------------------------------------------------------------------
// State (serialized read-modify-write so concurrent messages don't clobber it)
// ---------------------------------------------------------------------------

let stateQueue = Promise.resolve();

async function readState() {
  return (await chrome.storage.session.get(STORAGE.state))[STORAGE.state] ?? { phase: PHASE.idle };
}

/** @param {(s: object) => object | null} fn  return the new state, or null for "no change" */
function updateState(fn) {
  const run = stateQueue.then(async () => {
    const current = await readState();
    const next = await fn(current);
    if (!next) return current;
    await chrome.storage.session.set({ [STORAGE.state]: next });
    await applyBadge(next);
    return next;
  });
  stateQueue = run.catch(() => {});
  return run;
}

async function applyBadge(state) {
  const badge = {
    [PHASE.recording]: { text: 'REC', color: '#d93025' },
    [PHASE.finishing]: { text: '↑', color: '#1a73e8' },
    [PHASE.error]: { text: '!', color: '#f29900' },
  }[state.phase] ?? { text: '', color: '#000000' };
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
}

async function updateHistory(fn) {
  const list = (await chrome.storage.local.get(STORAGE.history))[STORAGE.history] ?? [];
  await chrome.storage.local.set({ [STORAGE.history]: fn(list) });
}

// ---------------------------------------------------------------------------
// Offscreen document (clipboard)
// ---------------------------------------------------------------------------

const OFFSCREEN_URL = 'offscreen/offscreen.html';
let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length > 0) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['CLIPBOARD'],
        justification: 'Copy the Google Drive link to the clipboard when recording stops, even if the popup is closed.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function copyToClipboard(text) {
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: TARGET.offscreen, type: MSG.OFFSCREEN_COPY, text });
    return Boolean(res?.ok);
  } catch (err) {
    console.error('Clipboard copy failed', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Recording lifecycle
// ---------------------------------------------------------------------------

async function startRecording() {
  const state = await readState();
  if (ACTIVE_PHASES.has(state.phase)) {
    // Already busy – just bring the recorder window forward.
    if (state.windowId) chrome.windows.update(state.windowId, { focused: true, state: 'normal' }).catch(() => {});
    return { ok: false, error: 'A recording is already in progress.' };
  }

  // Make sure we have a token (shows Google sign-in only if not connected yet).
  try {
    await defaultAuth().getToken({ interactive: true });
    await chrome.storage.local.set({ [STORAGE.connected]: true });
  } catch (err) {
    if (err instanceof AuthError && err.code === 'not_configured') {
      await openSetup();
      return { ok: false, error: 'Google Drive is not set up yet.', needsSetup: true };
    }
    await updateState(() => ({ phase: PHASE.error, error: explainAuthError(err) }));
    return { ok: false, error: explainAuthError(err) };
  }

  // Pre-create the offscreen document so the copy on Stop is instant.
  ensureOffscreen().catch((e) => console.warn('offscreen pre-create failed', e));

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('recorder/recorder.html'),
    type: 'popup',
    width: 480,
    height: 360,
    focused: true,
  });
  await updateState(() => ({ phase: PHASE.starting, windowId: win.id, startedAt: null }));
  return { ok: true };
}

/**
 * Stop: copy the link FIRST (the whole point of the design), then tell the
 * recorder to stop and flush the last chunk.
 * @param {'popup'|'shortcut'|'recorder'} source
 */
async function stopRecording(source) {
  const state = await readState();

  if (state.phase === PHASE.starting) {
    // Picker still open / Drive still preparing → cancel.
    sendToRecorder(MSG.RECORDER_STOP);
    return { ok: true, cancelled: true };
  }
  // `stopHandled` makes copy + notification happen exactly once per recording,
  // even if the upload already finished (tiny recordings) before we got here.
  const stoppable = state.phase === PHASE.recording || (state.phase === PHASE.done && !state.stopHandled);
  if (!stoppable || state.stopHandled) return { ok: false, error: 'Not recording.' };

  const copied = state.link ? await copyToClipboard(state.link) : false;

  let changed = false;
  await updateState((s) => {
    if (s.stopHandled) return null; // someone else already stopped
    changed = true;
    return {
      ...s,
      phase: s.phase === PHASE.recording ? PHASE.finishing : s.phase,
      stopHandled: true,
      stoppedAt: Date.now(),
      copied,
    };
  });
  if (source !== 'recorder') sendToRecorder(MSG.RECORDER_STOP);
  if (!changed) return { ok: true, link: state.link };

  await updateHistory((list) =>
    patchHistory(list, state.fileId, {
      status: state.phase === PHASE.done ? 'done' : 'uploading',
      durationMs: Date.now() - state.startedAt,
    }),
  );

  chrome.notifications.create(NOTIFY_STOP, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: copied ? 'Link copied to clipboard.' : 'Recording stopped',
    message: copied
      ? `${state.link}${state.warning ? `\n⚠ ${state.warning}` : ''}`
      : `Could not copy automatically. Open the SamySnap popup to copy:\n${state.link}`,
    priority: 1,
  });
  return { ok: true, link: state.link, copied };
}

function sendToRecorder(type, extra = {}) {
  chrome.runtime.sendMessage({ target: TARGET.recorder, type, ...extra }).catch(() => {
    /* recorder window not open */
  });
}

/** State patches from the recorder window. */
async function onRecorderUpdate(patch) {
  const prev = await readState();
  const next = await updateState((s) => ({ ...s, ...patch }));

  // Recording just began → remember the link in the history.
  if (patch.phase === PHASE.recording && prev.phase !== PHASE.recording) {
    await updateHistory((list) =>
      upsertHistory(list, {
        fileId: next.fileId,
        link: next.link,
        name: next.fileName,
        createdAt: next.startedAt,
        status: 'recording',
        shared: next.shared,
      }),
    );
  }

  if (patch.phase === PHASE.done && next.fileId) {
    await updateHistory((list) => patchHistory(list, next.fileId, { status: 'done' }));
  }

  if (patch.phase === PHASE.error && prev.phase !== PHASE.error) {
    if (next.fileId) await updateHistory((list) => patchHistory(list, next.fileId, { status: 'failed' }));
    if (next.canDownload) {
      chrome.notifications.create(NOTIFY_FAIL, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Upload failed – your recording is safe',
        message: `${next.error || 'Upload failed.'}\nRetry the upload or download the video.`,
        buttons: [{ title: 'Retry upload' }, { title: 'Download video' }],
        requireInteraction: true,
        priority: 2,
      });
    }
  }
}

function explainAuthError(err) {
  if (err instanceof AuthError) {
    if (err.code === 'not_configured') return 'Google Drive is not set up yet. Open the setup guide from the SamySnap popup.';
    if (err.code === 'cancelled') {
      return 'The Google window was closed before finishing. If Google showed an error page, re-check steps 4 and 5 of the setup guide.';
    }
  }
  const msg = String(err?.message || err);
  if (/client|OAuth2|bad client id|invalid_client|redirect_uri/i.test(msg)) {
    return 'Google did not accept your key. Re-check step 5 of the setup guide (the key and the pasted link).';
  }
  return `Google sign-in failed: ${msg}`;
}

const SETUP_URL = 'setup/setup.html';

/** Open the setup guide (focus it if already open). */
async function openSetup() {
  const url = chrome.runtime.getURL(SETUP_URL);
  // getContexts finds our own tabs without needing the "tabs" permission.
  const [existing] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] }).catch(() => []);
  if (existing && existing.tabId >= 0) {
    await chrome.tabs.update(existing.tabId, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url });
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

const handlers = {
  async [MSG.CONNECT]() {
    try {
      await defaultAuth().getToken({ interactive: true });
      await chrome.storage.local.set({ [STORAGE.connected]: true });
      // Warm the folder cache so the first recording starts faster (best effort).
      new DriveClient({ authFetch: defaultAuthFetch() }).ensureFolder().catch((e) => console.warn(e));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: explainAuthError(err) };
    }
  },
  async [MSG.DISCONNECT]() {
    await defaultAuth().disconnect();
    await chrome.storage.local.remove([STORAGE.connected, STORAGE.folderId]);
    return { ok: true };
  },
  async [MSG.STATUS]() {
    const c = await defaultAuth().config();
    const local = await chrome.storage.local.get(STORAGE.connected);
    return {
      ok: true,
      configured: c.mode !== 'none',
      mode: c.mode,
      connected: c.mode !== 'none' && Boolean(local[STORAGE.connected]),
      redirectUri: chrome.identity.getRedirectURL(),
      extensionId: chrome.runtime.id,
    };
  },
  async [MSG.SAVE_CLIENT_ID](msg) {
    const id = cleanClientId(msg.clientId);
    if (!isValidClientId(id)) {
      return { ok: false, error: 'That doesn’t look like a Client ID. It should end with “.apps.googleusercontent.com”.' };
    }
    const prev = (await chrome.storage.local.get(STORAGE.clientId))[STORAGE.clientId];
    if (prev !== id) {
      // New key → forget the old sign-in and folder (they belong to the old key).
      await chrome.storage.session.remove(STORAGE.token);
      await chrome.storage.local.remove([STORAGE.connected, STORAGE.folderId]);
    }
    await chrome.storage.local.set({ [STORAGE.clientId]: id });
    return { ok: true, clientId: id };
  },
  async [MSG.RESET_SETUP]() {
    await defaultAuth().disconnect().catch(() => {});
    await chrome.storage.session.remove(STORAGE.token);
    await chrome.storage.local.remove([STORAGE.clientId, STORAGE.connected, STORAGE.folderId, STORAGE.setupStep]);
    return { ok: true };
  },
  async [MSG.OPEN_SETUP]() {
    await openSetup();
    return { ok: true };
  },
  [MSG.START]: () => startRecording(),
  [MSG.STOP]: () => stopRecording('popup'),
  [MSG.RECORDER_STOPPED]: () => stopRecording('recorder'),
  async [MSG.RECORDER_UPDATE](msg) {
    await onRecorderUpdate(msg.patch || {});
    return { ok: true };
  },
  async [MSG.RETRY_UPLOAD]() {
    sendToRecorder(MSG.RECORDER_RETRY);
    return { ok: true };
  },
  async [MSG.DOWNLOAD_LOCAL]() {
    sendToRecorder(MSG.RECORDER_DOWNLOAD);
    return { ok: true };
  },
  async [MSG.RESET]() {
    await updateState((s) => (ACTIVE_PHASES.has(s.phase) ? null : { phase: PHASE.idle }));
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target && msg.target !== TARGET.background) return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // async response
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;
  const state = await readState();
  if (state.phase === PHASE.recording || state.phase === PHASE.starting) await stopRecording('shortcut');
  else if (state.phase !== PHASE.finishing) await startRecording();
});

chrome.notifications.onButtonClicked.addListener((id, index) => {
  if (id !== NOTIFY_FAIL) return;
  sendToRecorder(index === 0 ? MSG.RECORDER_RETRY : MSG.RECORDER_DOWNLOAD);
  chrome.notifications.clear(id);
});

// The recorder window holds the MediaRecorder; if it disappears mid-way, say so.
chrome.windows.onRemoved.addListener(async (windowId) => {
  await updateState((s) => {
    if (s.windowId !== windowId) return null;
    if (s.phase === PHASE.starting) return { phase: PHASE.idle };
    if (s.phase === PHASE.recording || s.phase === PHASE.finishing || (s.phase === PHASE.error && s.canDownload)) {
      return {
        ...s,
        phase: PHASE.error,
        windowId: null,
        canDownload: false,
        canRetry: false,
        error: 'The recorder window was closed before the upload finished. The Drive file may be incomplete.',
      };
    }
    return { ...s, windowId: null };
  });
});

// Fresh browser session → clear any stale badge.
chrome.runtime.onStartup.addListener(() => updateState(() => ({ phase: PHASE.idle })));
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const s = await readState();
  await applyBadge(s);
  // First install: open the friendly setup guide right away.
  if (reason === 'install') {
    const c = await defaultAuth().config();
    if (c.mode === 'none') await openSetup();
  }
});
