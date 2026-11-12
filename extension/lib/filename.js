// File naming: bug-YYYY-MM-DD_HH-mm-ss.webm (local time).

const pad = (n) => String(n).padStart(2, '0');

/**
 * @param {Date} [date=new Date()]
 * @returns {string} e.g. "bug-2026-11-12_14-03-09.webm"
 */
export function recordingFileName(date = new Date()) {
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const t = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `bug-${d}_${t}.webm`;
}

/** screenshot-YYYY-MM-DD_HH-mm-ss.png (local time). */
export function screenshotFileName(date = new Date()) {
  return recordingFileName(date).replace(/^bug-/, 'screenshot-').replace(/\.webm$/, '.png');
}

/** Format milliseconds as m:ss or h:mm:ss for the recording timer. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Human readable byte size (for the upload status line). */
export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
