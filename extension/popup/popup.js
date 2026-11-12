// Popup UI. It holds no recording logic: it renders the shared state from
// chrome.storage (written by the service worker) and sends commands.

import { STORAGE, isDriveLink } from '../lib/constants.js';
import { MSG, PHASE, TARGET } from '../lib/messages.js';
import { formatDuration, formatBytes } from '../lib/filename.js';
import { elapsedMs } from '../lib/timing.js';

const $ = (id) => document.getElementById(id);

let state = { phase: PHASE.idle };
let timerInterval = null;

const send = (type, extra = {}) => chrome.runtime.sendMessage({ target: TARGET.background, type, ...extra });

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Show exactly one of: setup guide CTA, connect button, main UI. */
function renderStatus({ configured, connected }) {
  $('setup-view').hidden = configured;
  $('connect-view').hidden = !configured || connected;
  $('main-view').hidden = !(configured && connected);
}

async function refreshStatus() {
  const status = await send(MSG.STATUS).catch(() => null);
  renderStatus(status ?? { configured: false, connected: false });
}

async function openSetup() {
  await send(MSG.OPEN_SETUP);
  window.close();
}

function render() {
  const s = state;
  const toggle = $('toggle');
  const label = $('toggle-label');
  const icon = toggle.querySelector('span');

  const recording = s.phase === PHASE.recording;
  const paused = recording && Boolean(s.paused);
  const starting = s.phase === PHASE.starting;
  const finishing = s.phase === PHASE.finishing;

  // Screenshot button: hidden while recording (the Pause button takes its place).
  $('screenshot').hidden = recording || starting;

  // Pause / resume button (only while recording).
  $('pause').hidden = !recording;
  $('pause').querySelector('span').className = paused ? 'play' : 'bars';
  $('pause-label').textContent = paused ? 'Resume' : 'Pause';

  toggle.classList.toggle('record', !recording && !starting);
  toggle.classList.toggle('stop', recording || starting);
  icon.className = recording || starting ? 'square' : 'dot';
  label.textContent = recording ? 'Stop & copy link' : starting ? 'Cancel' : 'Record';
  toggle.disabled = finishing;

  // Live line: timer + phase.
  $('live').hidden = !(recording || finishing || s.phase === PHASE.done);
  renderPhaseLabel(paused ? 'paused' : recording ? 'recording' : finishing ? 'finishing' : s.phase);
  updateTimer();
  clearInterval(timerInterval);
  if (recording && !paused) timerInterval = setInterval(updateTimer, 500);

  // Upload status line.
  const up = $('upload-status');
  if (recording || finishing || s.phase === PHASE.done) {
    up.hidden = false;
    const sizes = s.totalBytes ? ` (${formatBytes(s.uploadedBytes)} / ${formatBytes(s.totalBytes)})` : '';
    up.textContent =
      s.phase === PHASE.done
        ? `Upload complete${s.copied === false ? '' : ' – link is on your clipboard'}.`
        : `Uploading…${sizes}`;
  } else if (starting) {
    up.hidden = false;
    up.textContent = 'Choose a screen, window or tab in the picker…';
  } else {
    up.hidden = true;
  }

  // Warning + error.
  $('warning').hidden = !s.warning;
  $('warning').textContent = s.warning ? `⚠ ${s.warning}` : '';
  $('error-box').hidden = s.phase !== PHASE.error;
  $('error').textContent = s.error || '';
  $('retry').hidden = !s.canRetry;
  $('download').hidden = !s.canDownload;
}

/** Build the phase label with DOM APIs (no innerHTML). */
function renderPhaseLabel(phase) {
  const el = $('phase-label');
  el.replaceChildren();
  const icon = (cls, text = '') => Object.assign(document.createElement('span'), { className: cls, textContent: text });
  if (phase === 'paused') el.append(icon('paused-indicator', 'II'), ' Paused');
  else if (phase === 'recording') el.append(icon('dot rec-indicator'), ' Recording');
  else if (phase === 'finishing') el.append('Uploading…');
  else if (phase === PHASE.done) el.append('✓ Done');
}

function updateTimer() {
  const s = state;
  if (!s.startedAt) {
    $('timer').textContent = '';
    return;
  }
  $('timer').textContent = formatDuration(elapsedMs(s));
}

function renderHistory(list = []) {
  const ul = $('history');
  ul.replaceChildren();
  $('history-empty').hidden = list.length > 0;
  const tpl = $('history-item');
  for (const item of list) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    const a = li.querySelector('.name');
    a.textContent = item.name || item.link;
    if (isDriveLink(item.link)) a.href = item.link;
    a.title = item.link;
    const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : '';
    const status = { recording: '● recording', uploading: 'uploading…', done: '', failed: 'upload failed' }[item.status] ?? '';
    li.querySelector('.sub').textContent = [when, status, item.shared === false ? 'private' : ''].filter(Boolean).join(' · ');
    li.querySelector('.copy').addEventListener('click', (e) => copyLink(item.link, e.currentTarget));
    ul.appendChild(li);
  }
}

async function copyLink(link, button) {
  try {
    await navigator.clipboard.writeText(link);
    if (button) {
      button.textContent = 'Copied ✓';
      setTimeout(() => (button.textContent = 'Copy'), 1200);
    }
  } catch (err) {
    console.error(err);
  }
}

function showConnectError(msg) {
  const view = $('connect-view');
  let p = view.querySelector('.notice');
  if (!p) {
    p = document.createElement('p');
    p.className = 'notice err';
    view.appendChild(p);
  }
  p.textContent = msg;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

$('connect').addEventListener('click', async () => {
  $('connect').disabled = true;
  $('connect').textContent = 'Connecting…';
  const res = await send(MSG.CONNECT);
  $('connect').disabled = false;
  $('connect').textContent = 'Connect Google Drive';
  if (res?.ok) refreshStatus();
  else showConnectError(res?.error || 'Could not connect.');
});

$('toggle').addEventListener('click', async () => {
  if (state.phase === PHASE.recording) {
    // The popup is focused here, so copy directly too (belt and braces –
    // the service worker also copies via the offscreen document).
    if (state.link) copyLink(state.link);
    await send(MSG.STOP);
  } else if (state.phase === PHASE.starting) {
    await send(MSG.STOP);
  } else {
    const res = await send(MSG.START);
    if (res?.ok || res?.needsSetup) window.close(); // get out of the way of the picker / setup tab
  }
});

$('screenshot').addEventListener('click', async () => {
  // Clicking the toolbar icon granted activeTab; close the popup so it isn't in the way.
  const res = send(MSG.SCREENSHOT);
  window.close();
  await res;
});

// chrome:// pages can't be linked to directly, but an extension may open them.
$('shortcut').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});

$('pause').addEventListener('click', () => send(state.paused ? MSG.RESUME : MSG.PAUSE));
$('retry').addEventListener('click', () => send(MSG.RETRY_UPLOAD));
$('download').addEventListener('click', () => send(MSG.DOWNLOAD_LOCAL));
$('dismiss').addEventListener('click', () => send(MSG.RESET));

$('disconnect').addEventListener('click', async () => {
  await send(MSG.DISCONNECT);
  refreshStatus();
});

$('open-setup').addEventListener('click', openSetup);
$('connect-setup').addEventListener('click', openSetup);
$('footer-setup').addEventListener('click', openSetup);

/** Merge a patch into the saved settings. */
async function saveSettings(patch) {
  const settings = (await chrome.storage.local.get(STORAGE.settings))[STORAGE.settings] ?? {};
  await chrome.storage.local.set({ [STORAGE.settings]: { ...settings, ...patch } });
}

$('mic').addEventListener('change', (e) => saveSettings({ mic: e.target.checked }));


// ---------------------------------------------------------------------------
// Init + live updates
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[STORAGE.state]) {
    state = changes[STORAGE.state].newValue ?? { phase: PHASE.idle };
    render();
  }
  if (area === 'local' && changes[STORAGE.history]) renderHistory(changes[STORAGE.history].newValue);
  if (area === 'local' && (changes[STORAGE.connected] || changes[STORAGE.clientId])) refreshStatus();
});

async function init() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  const [session, local, commands] = await Promise.all([
    chrome.storage.session.get(STORAGE.state),
    chrome.storage.local.get([STORAGE.history, STORAGE.settings]),
    chrome.commands.getAll(),
  ]);
  state = session[STORAGE.state] ?? { phase: PHASE.idle };
  $('mic').checked = Boolean(local[STORAGE.settings]?.mic);
  const cmd = commands.find((c) => c.name === 'toggle-recording');
  $('shortcut').textContent = cmd?.shortcut ? `⌨ ${cmd.shortcut}` : '⌨ Set shortcut';
  $('shortcut').title = cmd?.shortcut
    ? `${cmd.shortcut} starts/stops recording. Click to change shortcuts.`
    : 'Click to choose a start/stop keyboard shortcut.';
  const shotCmd = commands.find((c) => c.name === 'take-screenshot');
  $('screenshot').title = `Screenshot of this tab → clipboard${shotCmd?.shortcut ? ` (${shotCmd.shortcut})` : ''}`;
  const pauseCmd = commands.find((c) => c.name === 'pause-recording');
  $('pause').title = pauseCmd?.shortcut ? `Pause / resume (${pauseCmd.shortcut})` : 'Pause / resume';
  renderHistory(local[STORAGE.history]);
  render();
  await refreshStatus();
}

init();
