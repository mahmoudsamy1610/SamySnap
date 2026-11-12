// Google sign-in.
//
// Two ways to configure it:
//   1. "web" (default, used by the setup wizard): the user pastes a Client ID
//      of type "Web application" into the wizard. We sign in with
//      chrome.identity.launchWebAuthFlow – no manifest editing, no reload.
//      Access tokens last ~1 h; we cache them in chrome.storage.session and
//      refresh silently (prompt=none) before they expire.
//   2. "chrome" (advanced): a "Chrome Extension" OAuth client ID put in
//      manifest.json → oauth2.client_id; we use chrome.identity.getAuthToken.
// In both cases the only scope is drive.file (files this app created).

import { STORAGE, DRIVE_SCOPE } from './constants.js';

export const CLIENT_ID_PLACEHOLDER = 'YOUR_CLIENT_ID';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const REFRESH_MARGIN_MS = 2 * 60 * 1000; // refresh 2 min before expiry

export class AuthError extends Error {
  /** @param {'not_configured'|'cancelled'|'failed'} code */
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Loose check of a Google OAuth client ID ("1234-abc.apps.googleusercontent.com"). */
export function isValidClientId(id) {
  return /^\d+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i.test(String(id || '').trim());
}

/** Accept common copy/paste noise: spaces, quotes, a "Client ID:" prefix. */
export function cleanClientId(raw) {
  const s = String(raw || '').trim().replace(/^client\s*id\s*:?\s*/i, '').replace(/^["']|["']$/g, '');
  const m = /\d+-[a-z0-9_-]+\.apps\.googleusercontent\.com/i.exec(s);
  return m ? m[0] : s;
}

export function buildAuthUrl({ clientId, redirectUri, interactive }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: DRIVE_SCOPE,
    include_granted_scopes: 'true',
  });
  if (!interactive) p.set('prompt', 'none');
  return `${AUTH_ENDPOINT}?${p}`;
}

/** Parse the redirect URL fragment (#access_token=…&expires_in=…). */
export function parseAuthRedirect(url) {
  const u = new URL(url);
  const params = new URLSearchParams(u.hash.replace(/^#/, '') || u.search.replace(/^\?/, ''));
  const error = params.get('error');
  if (error) return { error };
  const token = params.get('access_token');
  if (!token) return { error: 'no_token' };
  return { token, expiresIn: Number(params.get('expires_in') || 3600) };
}

/**
 * @param {object} deps
 * @param {typeof chrome.identity} deps.identity
 * @param {{get, set, remove}} deps.session  token cache (chrome.storage.session)
 * @param {{get}} deps.local  settings (chrome.storage.local) – holds the pasted client ID
 * @param {object} [deps.manifest]  chrome.runtime.getManifest()
 * @param {typeof fetch} [deps.fetch]
 * @param {() => number} [deps.now]
 */
export function createAuth({ identity, session, local, manifest, fetch: f = globalThis.fetch, now = Date.now }) {
  let silentInflight = null;

  async function config() {
    const clientId = await local.get(STORAGE.clientId);
    if (clientId) return { mode: 'web', clientId };
    const m = manifest?.oauth2?.client_id;
    if (m && !m.startsWith(CLIENT_ID_PLACEHOLDER)) return { mode: 'chrome', clientId: m };
    return { mode: 'none' };
  }

  async function webFlow(clientId, interactive) {
    const url = buildAuthUrl({ clientId, redirectUri: identity.getRedirectURL(), interactive });
    let redirect;
    try {
      redirect = await identity.launchWebAuthFlow(
        interactive
          ? { url, interactive: true }
          : { url, interactive: false, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10_000 },
      );
    } catch (err) {
      const msg = String(err?.message || err);
      if (interactive && /did not approve|closed|cancel/i.test(msg)) {
        throw new AuthError('cancelled', 'The Google sign-in window was closed.', { cause: err });
      }
      throw new AuthError('failed', msg, { cause: err });
    }
    const r = parseAuthRedirect(redirect);
    if (r.error) {
      if (r.error === 'access_denied') throw new AuthError('cancelled', 'Access to Google Drive was not allowed.');
      throw new AuthError('failed', `Google sign-in error: ${r.error}`);
    }
    await session.set(STORAGE.token, { token: r.token, expiresAt: now() + r.expiresIn * 1000 });
    return r.token;
  }

  /**
   * Get a valid access token.
   * interactive=false never shows UI; interactive=true shows Google's window if needed.
   */
  async function getToken({ interactive = false } = {}) {
    const c = await config();
    if (c.mode === 'none') throw new AuthError('not_configured', 'Google Drive is not set up yet.');

    if (c.mode === 'chrome') {
      const result = await identity.getAuthToken({ interactive });
      const token = typeof result === 'string' ? result : result?.token;
      if (!token) throw new AuthError('failed', 'Not connected to Google Drive');
      return token;
    }

    const cached = await session.get(STORAGE.token);
    if (cached?.token && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached.token;

    // Try silently first (deduplicated – several requests may need a token at once).
    try {
      if (!silentInflight) silentInflight = webFlow(c.clientId, false).finally(() => (silentInflight = null));
      return await silentInflight;
    } catch (err) {
      if (!interactive) throw err;
      return webFlow(c.clientId, true);
    }
  }

  /** Forget a (possibly expired/revoked) token. */
  async function removeToken(token) {
    const c = await config();
    if (c.mode === 'chrome') {
      if (token) await identity.removeCachedAuthToken({ token });
      return;
    }
    await session.remove(STORAGE.token);
  }

  /** Revoke at Google (best effort) and clear local caches. */
  async function disconnect() {
    let token;
    try {
      token = await getToken({ interactive: false });
    } catch {
      token = null;
    }
    if (token) {
      try {
        await f(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' });
      } catch {
        /* offline – still clear locally */
      }
    }
    await removeToken(token);
    await session.remove(STORAGE.token);
    if (identity.clearAllCachedAuthTokens) await identity.clearAllCachedAuthTokens().catch(() => {});
  }

  return { config, getToken, removeToken, disconnect };
}

/**
 * Wrap fetch so every request carries `Authorization: Bearer <token>`.
 * On HTTP 401 the cached token is removed and the request is retried ONCE
 * with a fresh token (handles expiry / revocation).
 */
export function createAuthFetch({ getToken: get, removeToken: remove, fetch: f = globalThis.fetch.bind(globalThis) }) {
  return async function authFetch(url, init = {}) {
    const send = async (token) => {
      const headers = new Headers(init.headers || {});
      headers.set('Authorization', `Bearer ${token}`);
      return f(url, { ...init, headers });
    };
    let token = await get();
    let res = await send(token);
    if (res.status === 401) {
      await remove(token);
      token = await get();
      res = await send(token);
    }
    return res;
  };
}

// ---------------------------------------------------------------------------
// Defaults for the extension (chrome.* wired in)
// ---------------------------------------------------------------------------

const area = (name) => ({
  async get(k) {
    return (await chrome.storage[name].get(k))[k];
  },
  async set(k, v) {
    await chrome.storage[name].set({ [k]: v });
  },
  async remove(k) {
    await chrome.storage[name].remove(k);
  },
});

let defaultInstance = null;
export function defaultAuth() {
  if (!defaultInstance) {
    defaultInstance = createAuth({
      identity: chrome.identity,
      session: area('session'),
      local: area('local'),
      manifest: chrome.runtime.getManifest(),
    });
  }
  return defaultInstance;
}

/**
 * authFetch for the recorder: refreshes silently, and if Google needs the user
 * (rare: e.g. signed out of Google mid-recording) shows the sign-in window.
 */
export function defaultAuthFetch() {
  const auth = defaultAuth();
  return createAuthFetch({
    getToken: async () => {
      try {
        return await auth.getToken({ interactive: false });
      } catch (err) {
        if (err instanceof AuthError && err.code === 'not_configured') throw err;
        return auth.getToken({ interactive: true });
      }
    },
    removeToken: (t) => auth.removeToken(t),
  });
}
