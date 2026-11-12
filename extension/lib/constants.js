// Shared constants. Kept free of `chrome.*` so the module can be imported by
// Node unit tests as well as by the extension pages.

/** Drive requires every non-final resumable chunk to be a multiple of this. */
export const CHUNK_ALIGN = 256 * 1024; // 256 KiB

/** MediaRecorder timeslice: a new data chunk every N ms. */
export const TIMESLICE_MS = 2000;

/** Target recording quality. */
export const VIDEO_BITS_PER_SECOND = 4_000_000; // ~4 Mbps
export const MAX_WIDTH = 1920;
export const MAX_HEIGHT = 1080;
export const MAX_FRAME_RATE = 30;

export const FOLDER_NAME = 'Bug Recordings';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const VIDEO_MIME = 'video/webm';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export const HISTORY_LIMIT = 5;

/** The only OAuth scope: files this app created (least privilege). */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** chrome.storage keys */
export const STORAGE = {
  folderId: 'driveFolderId', // local
  history: 'linkHistory', // local
  settings: 'settings', // local
  connected: 'driveConnected', // local
  clientId: 'googleClientId', // local – pasted in the setup wizard
  setupStep: 'setupStep', // local – where the user is in the setup wizard
  token: 'googleAccessToken', // session – cached {token, expiresAt} (web sign-in only)
  state: 'recState', // session (cleared when the browser restarts)
};

/** True only for https://drive.google.com/… links (never javascript: etc.). */
export function isDriveLink(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'drive.google.com';
  } catch {
    return false;
  }
}

/** Build the public "view" link for a Drive file. */
export function driveViewLink(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}
