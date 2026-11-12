// Google auth via chrome.identity.getAuthToken (OAuth client type "Chrome Extension").
// The scope (drive.file) is declared in manifest.json → oauth2.scopes.

/**
 * Get an OAuth access token. Chrome caches it and refreshes it for us.
 * @param {{interactive?: boolean, identity?: typeof chrome.identity}} [opts]
 * @returns {Promise<string>}
 */
export async function getToken({ interactive = false, identity = globalThis.chrome?.identity } = {}) {
  const result = await identity.getAuthToken({ interactive });
  // MV3 promise form resolves to { token, grantedScopes }; older Chrome resolved to a string.
  const token = typeof result === 'string' ? result : result?.token;
  if (!token) throw new Error('Not connected to Google Drive');
  return token;
}

/** Drop a (possibly expired/revoked) token from Chrome's cache. */
export async function removeToken(token, { identity = globalThis.chrome?.identity } = {}) {
  if (token) await identity.removeCachedAuthToken({ token });
}

/**
 * Wrap fetch so every request carries `Authorization: Bearer <token>`.
 * On HTTP 401 the cached token is removed and the request is retried ONCE
 * with a fresh token (handles expiry / revocation).
 *
 * @param {object} deps
 * @param {() => Promise<string>} deps.getToken
 * @param {(token: string) => Promise<void>} deps.removeToken
 * @param {typeof fetch} [deps.fetch]
 * @returns {(url: string, init?: RequestInit) => Promise<Response>}
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

/** Default authFetch for extension pages / the service worker. */
export function defaultAuthFetch() {
  return createAuthFetch({
    getToken: () => getToken({ interactive: false }),
    removeToken: (t) => removeToken(t),
  });
}

/**
 * Disconnect: revoke the token at Google and remove it from Chrome's cache.
 * Revoking is best effort (it may already be invalid).
 */
export async function disconnect({ identity = globalThis.chrome?.identity, fetch: f = globalThis.fetch } = {}) {
  let token;
  try {
    token = await getToken({ interactive: false, identity });
  } catch {
    return; // nothing cached
  }
  try {
    await f(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch {
    /* ignore network errors – the local cache is still cleared below */
  }
  await removeToken(token, { identity });
  if (identity.clearAllCachedAuthTokens) await identity.clearAllCachedAuthTokens();
}
