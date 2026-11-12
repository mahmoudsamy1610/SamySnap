// Offscreen document (reason: CLIPBOARD).
// The service worker has no DOM, and navigator.clipboard needs a focused
// document, so we use the classic textarea + execCommand('copy') trick, which
// works here even when no extension UI is open.

import { MSG, TARGET, isFromThisExtension } from '../lib/messages.js';

export function copyText(text, doc = document) {
  const el = doc.getElementById('clip');
  el.value = text;
  el.select();
  const ok = doc.execCommand('copy');
  el.value = '';
  return ok;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isFromThisExtension(sender)) return false;
  if (msg?.target !== TARGET.offscreen || msg.type !== MSG.OFFSCREEN_COPY) return false;
  try {
    sendResponse({ ok: copyText(String(msg.text ?? '')) });
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
  }
  return false;
});
