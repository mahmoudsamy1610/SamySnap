// Static checks of the extension package: manifest correctness, least
// privilege, and that every file referenced actually exists.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromKey } from '../../scripts/generate-key.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

describe('manifest.json', () => {
  test('is Manifest V3 with a module service worker', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background.service_worker, 'background.js');
    assert.equal(manifest.background.type, 'module');
  });

  test('requests ONLY the drive.file scope (manifest and web sign-in)', () => {
    assert.deepEqual(manifest.oauth2.scopes, ['https://www.googleapis.com/auth/drive.file']);
    assert.match(manifest.oauth2.client_id, /\.apps\.googleusercontent\.com$/);
    const auth = readFileSync(join(root, 'lib', 'auth.js'), 'utf8');
    assert.match(auth, /scope: DRIVE_SCOPE/);
    const consts = readFileSync(join(root, 'lib', 'constants.js'), 'utf8');
    assert.match(consts, /DRIVE_SCOPE = 'https:\/\/www\.googleapis\.com\/auth\/drive\.file'/);
  });

  test('has a stable key → a valid 32-char extension id', () => {
    assert.ok(manifest.key, 'key present');
    assert.match(extensionIdFromKey(manifest.key), /^[a-p]{32}$/);
  });

  test('permissions are exactly what the design needs', () => {
    assert.deepEqual(
      [...manifest.permissions].sort(),
      ['clipboardWrite', 'desktopCapture', 'identity', 'notifications', 'offscreen', 'storage'],
    );
    assert.ok(!manifest.permissions.includes('tabs'));
    assert.ok(!manifest.permissions.includes('<all_urls>'));
    for (const h of manifest.host_permissions) assert.match(h, /^https:\/\/(www|oauth2)\.googleapis\.com\/\*$/);
  });

  test('Alt+Shift+R toggles recording, Alt+Shift+P pauses/resumes', () => {
    assert.equal(manifest.commands['toggle-recording'].suggested_key.default, 'Alt+Shift+R');
    assert.equal(manifest.commands['pause-recording'].suggested_key.default, 'Alt+Shift+P');
  });

  test('all referenced files exist', () => {
    const files = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),
      'offscreen/offscreen.html',
      'recorder/recorder.html',
      'setup/setup.html',
    ];
    for (const f of files) assert.ok(existsSync(join(root, f)), f);
  });
});

describe('source hygiene', () => {
  const jsFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
    );

  test('every relative import resolves to a file', () => {
    for (const file of jsFiles(root)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
        assert.ok(existsSync(join(dirname(file), m[1])), `${file} → ${m[1]}`);
      }
    }
  });

  test('no remote code / eval (MV3 rule)', () => {
    for (const file of jsFiles(root)) {
      const src = readFileSync(file, 'utf8');
      assert.ok(!/\beval\(|new Function\(/.test(src), file);
      assert.ok(!/<script[^>]+src="https?:/.test(src), file);
    }
  });

  test('HTML pages only load local scripts', () => {
    for (const page of ['popup/popup.html', 'recorder/recorder.html', 'offscreen/offscreen.html', 'setup/setup.html']) {
      const html = readFileSync(join(root, page), 'utf8');
      for (const m of html.matchAll(/<script[^>]*src="([^"]+)"/g)) {
        assert.ok(!/^https?:/.test(m[1]), `${page} loads remote ${m[1]}`);
        assert.ok(existsSync(join(root, dirname(page), m[1])), `${page} → ${m[1]}`);
      }
    }
  });
});
