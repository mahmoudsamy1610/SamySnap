import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DriveClient, DriveError, describeShareError } from '../../extension/lib/drive.js';
import { STORAGE, FOLDER_NAME, FOLDER_MIME } from '../../extension/lib/constants.js';
import { FakeDrive, memoryStore } from '../helpers/fake-drive.js';

function setup(storeInit) {
  const drive = new FakeDrive();
  const f = drive.asFetch();
  const authFetch = (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', 'Bearer tok-1');
    return f(url, { ...init, headers });
  };
  const store = memoryStore(storeInit);
  const client = new DriveClient({
    authFetch,
    store,
    apiBase: `${drive.base}/drive/v3`,
    uploadBase: `${drive.base}/upload/drive/v3`,
  });
  return { drive, client, store };
}

describe('DriveClient.prepareRecordingFile', () => {
  test('creates the folder, an empty file inside it, a public permission and a session', async () => {
    const { drive, client, store } = setup();
    const r = await client.prepareRecordingFile('bug-2026-01-02_03-04-05.webm');

    const folderId = store.map.get(STORAGE.folderId);
    const folder = drive.files.get(folderId);
    assert.equal(folder.name, FOLDER_NAME);
    assert.equal(folder.mimeType, FOLDER_MIME);

    const file = drive.files.get(r.fileId);
    assert.equal(file.name, 'bug-2026-01-02_03-04-05.webm');
    assert.equal(file.mimeType, 'video/webm');
    assert.deepEqual(file.parents, [folderId]);
    assert.equal(file.data.length, 0, 'metadata only, no content yet');
    assert.deepEqual(file.permissions, [{ type: 'anyone', role: 'reader', allowFileDiscovery: false }]);

    assert.equal(r.link, `https://drive.google.com/file/d/${r.fileId}/view`);
    assert.equal(r.shared, true);
    assert.match(r.sessionUri, /\/upload\/session\//);
    assert.equal([...drive.sessions.values()][0].contentType, 'video/webm');
  });

  test('the resumable session is opened with PATCH on the SAME file id', async () => {
    const { drive, client } = setup();
    const r = await client.prepareRecordingFile('a.webm');
    const patch = drive.log.find((l) => l.method === 'PATCH');
    assert.equal(patch.path, `/upload/drive/v3/files/${r.fileId}`);
  });

  test('caches the folder id and reuses it (no second lookup)', async () => {
    const { drive, client } = setup();
    await client.prepareRecordingFile('a.webm');
    const lookups = () => drive.log.filter((l) => l.method === 'GET').length;
    const before = lookups();
    await client.prepareRecordingFile('b.webm');
    assert.equal(lookups(), before);
    const folders = [...drive.files.values()].filter((f) => f.mimeType === FOLDER_MIME);
    assert.equal(folders.length, 1);
  });

  test('finds an existing "Bug Recordings" folder instead of creating a duplicate', async () => {
    const { drive, client, store } = setup();
    const id = await client.createFolder();
    await client.prepareRecordingFile('a.webm');
    assert.equal(store.map.get(STORAGE.folderId), id);
    assert.equal([...drive.files.values()].filter((f) => f.mimeType === FOLDER_MIME).length, 1);
  });

  test('re-creates the folder if the cached one was deleted', async () => {
    const { drive, client, store } = setup({ [STORAGE.folderId]: 'deleted-folder' });
    const r = await client.prepareRecordingFile('a.webm');
    const newFolder = store.map.get(STORAGE.folderId);
    assert.notEqual(newFolder, 'deleted-folder');
    assert.deepEqual(drive.files.get(r.fileId).parents, [newFolder]);
  });

  test('sharing blocked (Workspace admin) → still returns the link, shared=false + warning', async () => {
    const { drive, client } = setup();
    drive.shareBlocked = true;
    const r = await client.prepareRecordingFile('a.webm');
    assert.equal(r.shared, false);
    assert.match(r.shareWarning, /blocked/i);
    assert.ok(r.sessionUri);
    assert.ok(r.link.endsWith(`/d/${r.fileId}/view`));
  });

  test('session failure deletes the empty file and throws', async () => {
    const { drive, client } = setup();
    drive.failSessionStart = true;
    await assert.rejects(client.prepareRecordingFile('a.webm'), DriveError);
    const videos = [...drive.files.values()].filter((f) => f.mimeType === 'video/webm');
    assert.equal(videos.length, 0);
  });

  test('DriveError carries status and Google reason', async () => {
    const { drive, client } = setup();
    drive.validTokens.clear();
    await assert.rejects(client.findFolder(), (e) => e instanceof DriveError && e.status === 401 && e.reason === 'authError');
  });

  test('deleteFile tolerates 404', async () => {
    const { client } = setup();
    await client.deleteFile('does-not-exist');
  });

  test('folder query escapes quotes and excludes trashed', async () => {
    const urls = [];
    const client = new DriveClient({
      authFetch: async (url) => {
        urls.push(decodeURIComponent(url));
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      },
      store: memoryStore(),
    });
    await client.findFolder("Bob's");
    assert.match(urls[0], /name = 'Bob\\'s'/);
    assert.match(urls[0], /trashed = false/);
  });
});

describe('describeShareError', () => {
  test('explains admin blocks', () => {
    assert.match(describeShareError(new DriveError('x', { status: 403, reason: 'publishOutNotPermitted' })), /admin/);
  });
  test('generic message otherwise', () => {
    assert.match(describeShareError(new Error('boom')), /boom/);
  });
});
