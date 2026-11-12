// Setup wizard: walks a non-technical user through registering their own
// (free, private) Google sign-in, then saves the pasted Client ID and connects.

import { STORAGE } from '../lib/constants.js';
import { MSG, TARGET } from '../lib/messages.js';
import { cleanClientId, isValidClientId } from '../lib/auth.js';

const $ = (id) => document.getElementById(id);
const LAST_GUIDED = 6; // steps 1..6 show the progress bar
const DONE = 7;

const send = (type, extra = {}) => chrome.runtime.sendMessage({ target: TARGET.background, type, ...extra });

let current = 0;

function show(step) {
  current = Math.max(0, Math.min(DONE, step));
  document.querySelectorAll('.step').forEach((el) => (el.hidden = Number(el.dataset.step) !== current));

  const guided = current >= 1 && current <= LAST_GUIDED;
  $('progress').hidden = !guided;
  $('progress-fill').style.width = `${(current / LAST_GUIDED) * 100}%`;
  $('progress-label').textContent = guided ? `Step ${current} of ${LAST_GUIDED}` : '';

  $('back').style.visibility = current === 0 || current === DONE ? 'hidden' : 'visible';
  $('next').hidden = current >= LAST_GUIDED;
  $('next').textContent = current === 0 ? 'Start →' : current === 5 ? 'I copied the Client ID →' : 'Done, next →';
  $('nav').hidden = current === DONE;

  if (current === LAST_GUIDED) setTimeout(() => $('client-id').focus(), 50);
  chrome.storage.local.set({ [STORAGE.setupStep]: current }).catch(() => {});
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Copy chips
// ---------------------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const chip = e.target.closest('.chip');
  if (chip) {
    try {
      await navigator.clipboard.writeText(chip.dataset.copy);
      const label = chip.querySelector('span');
      chip.classList.add('copied');
      label.textContent = 'Copied ✓';
      setTimeout(() => {
        chip.classList.remove('copied');
        label.textContent = 'Copy';
      }, 1500);
    } catch (err) {
      console.error(err);
    }
    return;
  }
  const go = e.target.closest('[data-goto]');
  if (go) {
    e.preventDefault();
    show(Number(go.dataset.goto));
  }
});

// ---------------------------------------------------------------------------
// Client ID field + connect
// ---------------------------------------------------------------------------

function validateField() {
  const input = $('client-id');
  const raw = input.value;
  const hint = $('client-id-hint');
  if (!raw.trim()) {
    input.classList.remove('valid', 'invalid');
    hint.textContent = 'Paste it with Ctrl+V (⌘V on Mac).';
    return false;
  }
  const ok = isValidClientId(cleanClientId(raw));
  input.classList.toggle('valid', ok);
  input.classList.toggle('invalid', !ok);
  hint.textContent = ok
    ? 'Looks right ✓'
    : 'Hmm, that doesn’t look like a Client ID. It should end with “.apps.googleusercontent.com”. (Not the “Client secret”.)';
  return ok;
}

$('client-id').addEventListener('input', () => {
  validateField();
  $('connect-error').hidden = true;
});

$('connect').addEventListener('click', async () => {
  const err = $('connect-error');
  err.hidden = true;
  if (!validateField()) {
    $('client-id').focus();
    return;
  }
  const btn = $('connect');
  btn.disabled = true;
  btn.textContent = 'Waiting for Google…';
  try {
    const saved = await send(MSG.SAVE_CLIENT_ID, { clientId: $('client-id').value });
    if (!saved?.ok) throw new Error(saved?.error || 'Could not save the key.');
    $('client-id').value = saved.clientId;
    const res = await send(MSG.CONNECT);
    if (!res?.ok) throw new Error(res?.error || 'Could not connect.');
    show(DONE);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Google Drive';
  }
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

$('next').addEventListener('click', () => show(current + 1));
$('change-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
$('back').addEventListener('click', () => show(current - 1));

$('close').addEventListener('click', async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id) chrome.tabs.remove(tab.id);
  else window.close();
});

$('start-over').addEventListener('click', async () => {
  await send(MSG.RESET_SETUP);
  $('client-id').value = '';
  validateField();
  show(1);
});

// Connected from somewhere else (e.g. the popup) → jump to the end.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE.connected]?.newValue && current !== DONE) show(DONE);
});

async function init() {
  const [status, local, commands] = await Promise.all([
    send(MSG.STATUS),
    chrome.storage.local.get([STORAGE.setupStep, STORAGE.clientId]),
    chrome.commands.getAll(),
  ]);
  $('redirect-uri').textContent = status.redirectUri;
  $('redirect-chip').dataset.copy = status.redirectUri;
  if (local[STORAGE.clientId]) $('client-id').value = local[STORAGE.clientId];
  validateField();

  const cmd = commands.find((c) => c.name === 'toggle-recording');
  const pauseCmd = commands.find((c) => c.name === 'pause-recording');
  if (cmd?.shortcut) $('shortcut').textContent = cmd.shortcut;
  else $('shortcut').textContent = 'not set';
  $('pause-shortcut').textContent = pauseCmd?.shortcut || 'not set';

  const forced = new URLSearchParams(location.search).get('step');
  if (forced !== null) show(Number(forced));
  else if (status.connected) show(DONE);
  else show(Math.min(Number(local[STORAGE.setupStep] ?? 0), LAST_GUIDED));
}

init();
