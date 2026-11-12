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

/**
 * Put a PNG on the clipboard. Tries the async Clipboard API first; if Chrome
 * refuses because this hidden document has no focus, falls back to a 'copy'
 * event where we attach the image file to the clipboard data ourselves.
 * @returns {Promise<{ok: boolean, method?: string, error?: string}>}
 */
export async function copyImage(dataUrl, doc = document) {
  const blob = await (await fetch(dataUrl)).blob();
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return { ok: true, method: 'clipboard-api' };
  } catch (err) {
    const file = new File([blob], 'screenshot.png', { type: 'image/png' });
    let attached = false;
    const onCopy = (e) => {
      try {
        e.clipboardData.items.add(file);
        attached = true;
      } catch {
        attached = false;
      }
      e.preventDefault();
    };
    doc.addEventListener('copy', onCopy, { once: true });
    const el = doc.getElementById('clip');
    el.value = ' ';
    el.select();
    doc.execCommand('copy');
    el.value = '';
    doc.removeEventListener('copy', onCopy);
    return attached ? { ok: true, method: 'copy-event' } : { ok: false, error: String(err?.message || err) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isFromThisExtension(sender)) return false;
  if (msg?.target !== TARGET.offscreen) return false;
  if (msg.type === MSG.OFFSCREEN_COPY) {
    try {
      sendResponse({ ok: copyText(String(msg.text ?? '')) });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return false;
  }
  if (msg.type === MSG.OFFSCREEN_COPY_IMAGE) {
    copyImage(String(msg.dataUrl)).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }
  return false;
});
