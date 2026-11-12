import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuth,
  createAuthFetch,
  AuthError,
  isValidClientId,
  cleanClientId,
  buildAuthUrl,
  parseAuthRedirect,
} from '../../extension/lib/auth.js';
import { STORAGE, DRIVE_SCOPE } from '../../extension/lib/constants.js';
import { memoryStore } from '../helpers/fake-drive.js';

const CLIENT = '1234567890-abcdef.apps.googleusercontent.com';
const REDIRECT = 'https://mlkhplkihjdfolnglmelgohmfnilomnl.chromiumapp.org/';

/** Fake chrome.identity. `flow` decides what launchWebAuthFlow returns per call. */
function fakeIdentity({ flow, chromeTokens = ['ctok'] } = {}) {
  const calls = { flows: [], removed: [], getAuthToken: [] };
  return {
    calls,
    getRedirectURL: () => REDIRECT,
    async launchWebAuthFlow(opts) {
      calls.flows.push(opts);
      return flow(opts, calls.flows.length);
    },
    async getAuthToken(opts) {
      calls.getAuthToken.push(opts);
      return { token: chromeTokens[0] };
    },
    async removeCachedAuthToken({ token }) {
      calls.removed.push(token);
    },
    async clearAllCachedAuthTokens() {
      calls.cleared = true;
    },
  };
}

/** Google-like redirect: echoes `state` from the request URL and grants drive.file. */
const okRedirect = (opts, token = 'tok', expiresIn = 3599, extra = {}) => {
  const req = new URL(opts.url).searchParams;
  const p = new URLSearchParams({
    access_token: token,
    token_type: 'Bearer',
    expires_in: String(expiresIn),
    scope: extra.scope ?? DRIVE_SCOPE,
    state: extra.state ?? req.get('state'),
  });
  return `${REDIRECT}#${p}`;
};

function setup({ clientId = CLIENT, manifestClientId = 'YOUR_CLIENT_ID.apps.googleusercontent.com', flow, now } = {}) {
  const identity = fakeIdentity({ flow: flow ?? ((opts) => okRedirect(opts)) });
  const session = memoryStore();
  const local = memoryStore(clientId ? { [STORAGE.clientId]: clientId } : {});
  let t = 1_000_000;
  const clock = now ?? { now: () => t, advance: (ms) => (t += ms) };
  const auth = createAuth({
    identity,
    session,
    local,
    manifest: { oauth2: { client_id: manifestClientId } },
    now: clock.now,
    fetch: async () => new Response(''),
  });
  return { auth, identity, session, local, clock };
}

describe('client id helpers', () => {
  test('isValidClientId', () => {
    assert.ok(isValidClientId(CLIENT));
    assert.ok(isValidClientId(`  ${CLIENT}  `));
    assert.ok(!isValidClientId('GOCSPX-secretlooking'));
    assert.ok(!isValidClientId(''));
    assert.ok(!isValidClientId('abc.apps.googleusercontent.com'));
  });
  test('cleanClientId strips copy/paste noise', () => {
    assert.equal(cleanClientId(`Client ID: "${CLIENT}"\n`), CLIENT);
    assert.equal(cleanClientId(` ${CLIENT} `), CLIENT);
    assert.equal(cleanClientId('nonsense'), 'nonsense');
  });
});

describe('auth URL / redirect parsing', () => {
  test('requests ONLY drive.file with the implicit token flow', () => {
    const u = new URL(buildAuthUrl({ clientId: CLIENT, redirectUri: REDIRECT, interactive: true }));
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(u.searchParams.get('scope'), DRIVE_SCOPE);
    assert.equal(u.searchParams.get('response_type'), 'token');
    assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(u.searchParams.get('client_id'), CLIENT);
    assert.equal(u.searchParams.get('prompt'), null);
  });
  test('silent flow uses prompt=none', () => {
    const u = new URL(buildAuthUrl({ clientId: CLIENT, redirectUri: REDIRECT, interactive: false }));
    assert.equal(u.searchParams.get('prompt'), 'none');
  });
  test('parses token, expiry, state and scopes from the fragment', () => {
    const r = parseAuthRedirect(`${REDIRECT}#access_token=abc&expires_in=100&state=s1&scope=a%20b`);
    assert.deepEqual(r, { token: 'abc', expiresIn: 100, state: 's1', scopes: ['a', 'b'] });
  });
  test('auth URL carries the state parameter', () => {
    const u = new URL(buildAuthUrl({ clientId: CLIENT, redirectUri: REDIRECT, interactive: true, state: 'xyz' }));
    assert.equal(u.searchParams.get('state'), 'xyz');
  });
  test('parses errors', () => {
    assert.deepEqual(parseAuthRedirect(`${REDIRECT}#error=access_denied`), { error: 'access_denied' });
    assert.deepEqual(parseAuthRedirect(`${REDIRECT}?error=interaction_required`), { error: 'interaction_required' });
    assert.deepEqual(parseAuthRedirect(REDIRECT), { error: 'no_token' });
  });
});

describe('createAuth – configuration', () => {
  test('nothing set up → not_configured', async () => {
    const { auth } = setup({ clientId: null });
    assert.deepEqual(await auth.config(), { mode: 'none' });
    await assert.rejects(auth.getToken(), (e) => e instanceof AuthError && e.code === 'not_configured');
  });
  test('pasted client id → web mode', async () => {
    const { auth } = setup();
    assert.deepEqual(await auth.config(), { mode: 'web', clientId: CLIENT });
  });
  test('manifest client id (advanced) → chrome.identity.getAuthToken', async () => {
    const { auth, identity } = setup({ clientId: null, manifestClientId: CLIENT });
    assert.equal((await auth.config()).mode, 'chrome');
    assert.equal(await auth.getToken({ interactive: true }), 'ctok');
    assert.deepEqual(identity.calls.getAuthToken, [{ interactive: true }]);
    await auth.removeToken('ctok');
    assert.deepEqual(identity.calls.removed, ['ctok']);
  });
});

describe('createAuth – web sign-in', () => {
  test('silent first; caches the token in session storage', async () => {
    const { auth, identity, session } = setup();
    assert.equal(await auth.getToken(), 'tok');
    assert.equal(identity.calls.flows.length, 1);
    assert.equal(identity.calls.flows[0].interactive, false);
    assert.ok((await session.get(STORAGE.token)).expiresAt > 0);
    assert.equal(await auth.getToken(), 'tok');
    assert.equal(identity.calls.flows.length, 1, 'served from cache');
  });

  test('refreshes before expiry', async () => {
    let n = 0;
    const { auth, clock } = setup({ flow: (opts) => okRedirect(opts, `tok${++n}`, 3600) });
    assert.equal(await auth.getToken(), 'tok1');
    clock.advance(3600_000 - 60_000); // inside the 2-minute refresh margin
    assert.equal(await auth.getToken(), 'tok2');
  });

  test('silent fails → interactive window when allowed', async () => {
    const { auth, identity } = setup({
      flow: (opts) => (opts.interactive ? okRedirect(opts, 'itok') : Promise.reject(new Error('User interaction required.'))),
    });
    await assert.rejects(auth.getToken({ interactive: false }), AuthError);
    assert.equal(await auth.getToken({ interactive: true }), 'itok');
    assert.deepEqual(identity.calls.flows.map((f) => f.interactive), [false, false, true]);
  });

  test('closing the Google window → cancelled', async () => {
    const { auth } = setup({
      flow: (opts) => Promise.reject(new Error(opts.interactive ? 'The user did not approve access.' : 'no')),
    });
    await assert.rejects(auth.getToken({ interactive: true }), (e) => e.code === 'cancelled');
  });

  test('access_denied in redirect → cancelled; other errors → failed', async () => {
    const denied = setup({ flow: () => `${REDIRECT}#error=access_denied` });
    await assert.rejects(denied.auth.getToken(), (e) => e.code === 'cancelled');
    const other = setup({ flow: () => `${REDIRECT}#error=server_error` });
    await assert.rejects(other.auth.getToken(), (e) => e.code === 'failed');
  });

  test('concurrent callers share one silent sign-in', async () => {
    const { auth, identity } = setup({ flow: (opts) => new Promise((r) => setTimeout(() => r(okRedirect(opts)), 5)) });
    const tokens = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);
    assert.deepEqual(tokens, ['tok', 'tok', 'tok']);
    assert.equal(identity.calls.flows.length, 1);
  });

  test('SECURITY: a response with a different state is rejected (CSRF / token injection)', async () => {
    const { auth, session } = setup({ flow: (opts) => okRedirect(opts, 'evil', 3600, { state: 'forged' }) });
    await assert.rejects(auth.getToken(), (e) => e.code === 'failed' && /did not match/.test(e.message));
    assert.equal(await session.get(STORAGE.token), undefined, 'forged token not cached');
  });

  test('SECURITY: every sign-in uses a fresh random state', async () => {
    const { auth, identity } = setup();
    await auth.getToken();
    await auth.removeToken();
    await auth.getToken();
    const states = identity.calls.flows.map((f) => new URL(f.url).searchParams.get('state'));
    assert.equal(states.length, 2);
    assert.match(states[0], /^[0-9a-f]{32}$/);
    assert.notEqual(states[0], states[1]);
  });

  test('user unticked the Drive permission → scope_denied with a clear message', async () => {
    const { auth, session } = setup({ flow: (opts) => okRedirect(opts, 'tok', 3600, { scope: 'openid' }) });
    await assert.rejects(auth.getToken(), (e) => e.code === 'scope_denied' && /tick the Drive box/.test(e.message));
    assert.equal(await session.get(STORAGE.token), undefined);
  });

  test('removeToken clears the cache → next call signs in again', async () => {
    const { auth, identity } = setup();
    await auth.getToken();
    await auth.removeToken('tok');
    await auth.getToken();
    assert.equal(identity.calls.flows.length, 2);
  });

  test('disconnect revokes with the token in the POST body (not the URL) and clears the cache', async () => {
    const calls = [];
    const identity = fakeIdentity({ flow: (opts) => okRedirect(opts, 'secret-tok') });
    const session = memoryStore();
    const auth = createAuth({
      identity,
      session,
      local: memoryStore({ [STORAGE.clientId]: CLIENT }),
      manifest: {},
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response('');
      },
    });
    await auth.getToken();
    await auth.disconnect();
    assert.equal(calls[0].url, 'https://oauth2.googleapis.com/revoke');
    assert.ok(!calls[0].url.includes('secret-tok'));
    assert.equal(calls[0].init.body, 'token=secret-tok');
    assert.equal(await session.get(STORAGE.token), undefined);
  });
});

describe('createAuthFetch', () => {
  test('adds the bearer token and keeps other headers', async () => {
    let seen;
    const authFetch = createAuthFetch({
      getToken: async () => 't1',
      removeToken: async () => {},
      fetch: async (url, init) => {
        seen = init.headers;
        return new Response('ok');
      },
    });
    await authFetch('https://x', { headers: { 'Content-Range': 'bytes */*' } });
    assert.equal(seen.get('Authorization'), 'Bearer t1');
    assert.equal(seen.get('Content-Range'), 'bytes */*');
  });

  test('on 401: removes the cached token and retries ONCE with a fresh one', async () => {
    const tokens = ['expired', 'fresh'];
    const removed = [];
    const sent = [];
    const authFetch = createAuthFetch({
      getToken: async () => tokens[0],
      removeToken: async (t) => {
        removed.push(t);
        tokens.shift();
      },
      fetch: async (url, init) => {
        const t = init.headers.get('Authorization');
        sent.push(t);
        return new Response('', { status: t === 'Bearer fresh' ? 200 : 401 });
      },
    });
    const res = await authFetch('https://x');
    assert.equal(res.status, 200);
    assert.deepEqual(removed, ['expired']);
    assert.deepEqual(sent, ['Bearer expired', 'Bearer fresh']);
  });

  test('does not loop: a second 401 is returned to the caller', async () => {
    let n = 0;
    const authFetch = createAuthFetch({
      getToken: async () => 't',
      removeToken: async () => {},
      fetch: async () => {
        n++;
        return new Response('', { status: 401 });
      },
    });
    assert.equal((await authFetch('https://x')).status, 401);
    assert.equal(n, 2);
  });

  test('re-sends the same Blob body on retry', async () => {
    const bodies = [];
    let first = true;
    const authFetch = createAuthFetch({
      getToken: async () => 't',
      removeToken: async () => {},
      fetch: async (url, init) => {
        bodies.push(await init.body.text());
        const status = first ? 401 : 200;
        first = false;
        return new Response('', { status });
      },
    });
    await authFetch('https://x', { method: 'PUT', body: new Blob(['hello']) });
    assert.deepEqual(bodies, ['hello', 'hello']);
  });
});
