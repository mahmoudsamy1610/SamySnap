// The "last 5 links" list shown in the popup (stored in chrome.storage.local).

import { HISTORY_LIMIT } from './constants.js';

/**
 * Insert or update an entry (matched by fileId), newest first, capped.
 * Pure function so it can be unit-tested.
 * @param {Array<{fileId: string}>} list
 * @param {{fileId: string}} entry
 */
export function upsertHistory(list, entry, limit = HISTORY_LIMIT) {
  const existing = (list || []).find((e) => e.fileId === entry.fileId);
  const merged = existing ? { ...existing, ...entry } : entry;
  const rest = (list || []).filter((e) => e.fileId !== entry.fileId);
  return [merged, ...rest].slice(0, limit);
}

/** Update fields of an existing entry without moving it. */
export function patchHistory(list, fileId, patch) {
  return (list || []).map((e) => (e.fileId === fileId ? { ...e, ...patch } : e));
}
