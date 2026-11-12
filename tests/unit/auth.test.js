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

const okRedirect = (token = 'tok', expiresIn = 3599) => `${REDIRECT}#access_token=${token}&token_type=Bearer&expires_in=${expiresIn}&scope=x`;

function setup({ clientId = CLIENT, manifestClientId = 'YOUR_CLIENT_ID.apps.googleusercontent.com', flow, now } = {}) {
  const identity = fakeIdentity({ flow: flow ?? (() => okRedirect()) });
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
  test('parses token and expiry from the fragment', () => {
    assert.deepEqual(parseAuthRedirect(okRedirect('abc', 100)), { token: 'abc', expiresIn: 100 });
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
    const { auth, clock } = setup({ flow: () => okRedirect(`tok${++n}`, 3600) });
    assert.equal(await auth.getToken(), 'tok1');
    clock.advance(3600_000 - 60_000); // inside the 2-minute refresh margin
    assert.equal(await auth.getToken(), 'tok2');
  });

  test('silent fails → interactive window when allowed', async () => {
    const { auth, identity } = setup({
      flow: (opts) => (opts.interactive ? okRedirect('itok') : Promise.reject(new Error('User interaction required.'))),
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
    const { auth, identity } = setup({ flow: () => new Promise((r) => setTimeout(() => r(okRedirect()), 5)) });
    const tokens = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);
    assert.deepEqual(tokens, ['tok', 'tok', 'tok']);
    assert.equal(identity.calls.flows.length, 1);
  });

  test('removeToken clears the cache → next call signs in again', async () => {
    const { auth, identity } = setup();
    await auth.getToken();
    await auth.removeToken('tok');
    await auth.getToken();
    assert.equal(identity.calls.flows.length, 2);
  });

  test('disconnect clears the cached token', async () => {
    const { auth, session } = setup();
    await auth.getToken();
    await auth.disconnect();
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
