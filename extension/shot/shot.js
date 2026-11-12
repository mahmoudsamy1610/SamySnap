// Screenshot toast: a small focused window that puts the screenshot on the
// clipboard (Chrome only lets a FOCUSED page write images to the clipboard –
// the hidden offscreen document can't), shows a thumbnail, then closes itself.

import { STORAGE } from '../lib/constants.js';

const $ = (id) => document.getElementById(id);
const AUTO_CLOSE_MS = 2200;
let closeTimer = null;
let shot = null;

function scheduleClose(ms = AUTO_CLOSE_MS) {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => window.close(), ms);
}

async function copy(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  window.focus();
  await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
}

async function init() {
  const data = await chrome.storage.session.get(STORAGE.screenshot);
  shot = data[STORAGE.screenshot];
  await chrome.storage.session.remove(STORAGE.screenshot); // don't keep screenshots around
  if (!shot?.dataUrl) {
    $('status').textContent = 'No screenshot found';
    $('status').className = 'status err';
    scheduleClose(3000);
    return;
  }
  $('preview').src = shot.dataUrl;
  try {
    await copy(shot.dataUrl);
    $('status').textContent = 'Screenshot copied ✓';
    $('status').className = 'status ok';
    document.title = 'Screenshot copied';
    scheduleClose();
  } catch (err) {
    console.error(err);
    $('status').textContent = 'Could not copy – save it instead';
    $('status').className = 'status err';
    $('hint').textContent = String(err?.message || err);
  }
}

$('download').addEventListener('click', () => {
  if (!shot?.dataUrl) return;
  const a = document.createElement('a');
  a.href = shot.dataUrl;
  a.download = shot.fileName || 'screenshot.png';
  a.click();
  scheduleClose(1500);
});

$('keep').addEventListener('click', () => {
  clearTimeout(closeTimer);
  $('keep').hidden = true;
});

// Hovering means "I'm looking at it" – don't vanish under the mouse.
document.addEventListener('mouseenter', () => clearTimeout(closeTimer));
document.addEventListener('mouseleave', () => {
  if (!$('keep').hidden) scheduleClose(1200);
});

init();
