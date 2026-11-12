// Minimal Google Drive v3 client — only what the recorder needs.
// Works with scope drive.file: the extension can only see files/folders it created.

import {
  DRIVE_API,
  DRIVE_UPLOAD_API,
  FOLDER_MIME,
  FOLDER_NAME,
  VIDEO_MIME,
  STORAGE,
  driveViewLink,
} from './constants.js';

export class DriveError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, reason?: string, body?: any}} [info]
   */
  constructor(message, { status, reason, body } = {}) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.reason = reason;
    this.body = body;
  }
}

/** Turn a non-OK Drive response into a DriveError with Google's reason code. */
async function toDriveError(res, what) {
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const reason = body?.error?.errors?.[0]?.reason || body?.error?.status;
  const msg = body?.error?.message || res.statusText || 'request failed';
  return new DriveError(`${what}: ${res.status} ${msg}`, { status: res.status, reason, body });
}

/** Simple key/value store adapter over chrome.storage.local. */
export const chromeLocalStore = {
  async get(key) {
    return (await chrome.storage.local.get(key))[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
};

export class DriveClient {
  /**
   * @param {object} deps
   * @param {(url: string, init?: RequestInit) => Promise<Response>} deps.authFetch  fetch that adds the bearer token
   * @param {{get, set, remove}} [deps.store]  used to cache the folder ID
   * @param {string} [deps.apiBase]
   * @param {string} [deps.uploadBase]
   */
  constructor({ authFetch, store = chromeLocalStore, apiBase = DRIVE_API, uploadBase = DRIVE_UPLOAD_API }) {
    this.fetch = authFetch;
    this.store = store;
    this.apiBase = apiBase;
    this.uploadBase = uploadBase;
  }

  async #json(url, init, what) {
    const res = await this.fetch(url, init);
    if (!res.ok) throw await toDriveError(res, what);
    return res.status === 204 ? null : res.json();
  }

  /** Find the "Bug Recordings" folder (one this app created) or null. */
  async findFolder(name = FOLDER_NAME) {
    const q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const url = `${this.apiBase}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1&spaces=drive`;
    const data = await this.#json(url, { method: 'GET' }, 'Find folder');
    return data.files?.[0]?.id ?? null;
  }

  async createFolder(name = FOLDER_NAME) {
    const data = await this.#json(
      `${this.apiBase}/files?fields=id`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
      },
      'Create folder',
    );
    return data.id;
  }

  /** Return the cached folder ID, or find/create the folder and cache it. */
  async ensureFolder({ refresh = false } = {}) {
    if (!refresh) {
      const cached = await this.store.get(STORAGE.folderId);
      if (cached) return cached;
    }
    const id = (await this.findFolder()) ?? (await this.createFolder());
    await this.store.set(STORAGE.folderId, id);
    return id;
  }

  /** files.create with metadata only → empty file, returns its ID. */
  async createEmptyFile(name, parentId) {
    const data = await this.#json(
      `${this.apiBase}/files?fields=id`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name, mimeType: VIDEO_MIME, parents: parentId ? [parentId] : undefined }),
      },
      'Create file',
    );
    return data.id;
  }

  /** permissions.create: anyone with the link can view, not searchable. */
  async shareAnyoneWithLink(fileId) {
    await this.#json(
      `${this.apiBase}/files/${fileId}/permissions?fields=id`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ type: 'anyone', role: 'reader', allowFileDiscovery: false }),
      },
      'Share file',
    );
  }

  /**
   * Open a resumable upload session for an EXISTING file (PATCH = update content).
   * @returns {Promise<string>} the session URI from the Location header
   */
  async startResumableSession(fileId, mimeType = VIDEO_MIME) {
    const res = await this.fetch(`${this.uploadBase}/files/${fileId}?uploadType=resumable`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
      },
      body: '{}',
    });
    if (!res.ok) throw await toDriveError(res, 'Start upload session');
    const location = res.headers.get('Location');
    if (!location) throw new DriveError('Start upload session: no Location header', { status: res.status });
    return location;
  }

  async deleteFile(fileId) {
    const res = await this.fetch(`${this.apiBase}/files/${fileId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw await toDriveError(res, 'Delete file');
  }

  /**
   * Everything that must happen BEFORE recording:
   *   a) empty file in "Bug Recordings"  b) anyone-with-link reader permission
   *   c) build the link                  d) resumable session for the same file
   * (b) and (d) run in parallel since both only need the file ID.
   *
   * If sharing is refused (e.g. a Workspace admin blocks public links) the
   * recording still works; `shareWarning` explains the link is private.
   *
   * @param {string} name
   * @returns {Promise<{fileId: string, link: string, sessionUri: string, shared: boolean, shareWarning?: string}>}
   */
  async prepareRecordingFile(name) {
    let folderId = await this.ensureFolder();
    let fileId;
    try {
      fileId = await this.createEmptyFile(name, folderId);
    } catch (err) {
      // Cached folder deleted/trashed by the user → re-create it and retry once.
      if (err instanceof DriveError && err.status === 404) {
        await this.store.remove(STORAGE.folderId);
        folderId = await this.ensureFolder({ refresh: true });
        fileId = await this.createEmptyFile(name, folderId);
      } else {
        throw err;
      }
    }

    const [share, session] = await Promise.allSettled([
      this.shareAnyoneWithLink(fileId),
      this.startResumableSession(fileId),
    ]);

    if (session.status === 'rejected') {
      // Without a session we cannot upload; clean up the empty file.
      await this.deleteFile(fileId).catch(() => {});
      throw session.reason;
    }

    const result = { fileId, link: driveViewLink(fileId), sessionUri: session.value, shared: true };
    if (share.status === 'rejected') {
      result.shared = false;
      result.shareWarning = describeShareError(share.reason);
    }
    return result;
  }
}

/** Human friendly explanation for a failed permissions.create. */
export function describeShareError(err) {
  const reason = err?.reason || '';
  if (err?.status === 403 || /sharing|publishOutNotPermitted|cannotShare/i.test(reason)) {
    return (
      'Public sharing is blocked for your account (probably by a Google Workspace admin). ' +
      'The link was copied, but only people who already have access can open it.'
    );
  }
  return `Could not make the file public (${err?.message || 'unknown error'}). The link only works for people with access.`;
}
