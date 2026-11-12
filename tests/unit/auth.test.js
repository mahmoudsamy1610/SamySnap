import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthFetch, getToken, removeToken, disconnect } from '../../extension/lib/auth.js';

function fakeIdentity(tokens) {
  const calls = { get: [], removed: [] };
  const queue = [...tokens];
  return {
    calls,
    identity: {
      async getAuthToken(opts) {
        calls.get.push(opts);
        const t = queue.length > 1 ? queue.shift() : queue[0];
        if (t instanceof Error) throw t;
        return t;
      },
      async removeCachedAuthToken({ token }) {
        calls.removed.push(token);
      },
      async clearAllCachedAuthTokens() {
        calls.cleared = true;
      },
    },
  };
}

describe('getToken', () => {
  test('supports the MV3 {token} result', async () => {
    const { identity } = fakeIdentity([{ token: 'abc', grantedScopes: [] }]);
    assert.equal(await getToken({ identity }), 'abc');
  });
  test('supports the legacy string result', async () => {
    const { identity } = fakeIdentity(['abc']);
    assert.equal(await getToken({ identity }), 'abc');
  });
  test('passes interactive through and defaults to false', async () => {
    const { identity, calls } = fakeIdentity(['abc']);
    await getToken({ identity });
    await getToken({ identity, interactive: true });
    assert.deepEqual(calls.get, [{ interactive: false }, { interactive: true }]);
  });
  test('throws when no token', async () => {
    const { identity } = fakeIdentity([{}]);
    await assert.rejects(getToken({ identity }), /Not connected/);
  });
  test('removeToken ignores empty token', async () => {
    const { identity, calls } = fakeIdentity(['x']);
    await removeToken('', { identity });
    assert.deepEqual(calls.removed, []);
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
    const res = await authFetch('https://x');
    assert.equal(res.status, 401);
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

describe('disconnect', () => {
  test('revokes and clears cached tokens', async () => {
    const { identity, calls } = fakeIdentity(['tok']);
    const revoked = [];
    await disconnect({ identity, fetch: async (url) => revoked.push(url) });
    assert.match(revoked[0], /revoke\?token=tok/);
    assert.deepEqual(calls.removed, ['tok']);
    assert.ok(calls.cleared);
  });
  test('is a no-op when not connected', async () => {
    const { identity, calls } = fakeIdentity([new Error('no')]);
    await disconnect({ identity, fetch: async () => assert.fail('should not revoke') });
    assert.deepEqual(calls.removed, []);
  });
  test('still clears the cache if revoke fails (offline)', async () => {
    const { identity, calls } = fakeIdentity(['tok']);
    await disconnect({ identity, fetch: async () => { throw new TypeError('offline'); } });
    assert.deepEqual(calls.removed, ['tok']);
  });
});
