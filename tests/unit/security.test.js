// Security guards that don't fit a single module.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFromThisExtension } from '../../extension/lib/messages.js';
import { isDriveLink } from '../../extension/lib/constants.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const ID = 'mlkhplkihjdfolnglmelgohmfnilomnl';

describe('message sender check', () => {
  test('accepts our own pages, offscreen document and service worker', () => {
    assert.ok(isFromThisExtension({ id: ID, url: `chrome-extension://${ID}/popup/popup.html` }, ID));
    assert.ok(isFromThisExtension({ id: ID, url: `chrome-extension://${ID}/offscreen/offscreen.html` }, ID));
    assert.ok(isFromThisExtension({ id: ID }, ID));
  });
  test('rejects other extensions, web pages and missing senders', () => {
    assert.ok(!isFromThisExtension({ id: 'otherextensionidotherextensionid', url: 'chrome-extension://other/' }, ID));
    assert.ok(!isFromThisExtension({ id: ID, url: 'https://evil.example/' }, ID), 'content-script-like sender');
    assert.ok(!isFromThisExtension(undefined, ID));
    assert.ok(!isFromThisExtension({ id: ID }, undefined));
  });
});

describe('isDriveLink', () => {
  test('only https://drive.google.com links', () => {
    assert.ok(isDriveLink('https://drive.google.com/file/d/abc/view'));
    assert.ok(!isDriveLink('javascript:alert(1)'));
    assert.ok(!isDriveLink('http://drive.google.com/file/d/abc/view'));
    assert.ok(!isDriveLink('https://drive.google.com.evil.com/x'));
    assert.ok(!isDriveLink('https://evil.com/?drive.google.com'));
    assert.ok(!isDriveLink('not a url'));
  });
});

describe('manifest attack surface', () => {
  test('strict CSP: only our own scripts, no plugins, no <base> tricks', () => {
    const csp = manifest.content_security_policy?.extension_pages || '';
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.ok(!/unsafe-eval|unsafe-inline|https?:/.test(csp));
  });
  test('no content scripts, no web-accessible resources, not externally connectable', () => {
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.web_accessible_resources, undefined);
    assert.equal(manifest.externally_connectable, undefined);
  });
  test('activeTab only (no standing site access): granted per tab when the user presses a shortcut / clicks the icon', () => {
    assert.ok(manifest.permissions.includes('activeTab'));
    assert.ok(!JSON.stringify(manifest).includes('<all_urls>'));
  });
  test('no access to websites (only Google APIs)', () => {
    assert.ok(!manifest.permissions.some((p) => /tabs|<all_urls>|webRequest|scripting|history|cookies/.test(p)));
    assert.ok(manifest.host_permissions.every((h) => /^https:\/\/(www|oauth2)\.googleapis\.com\/\*$/.test(h)));
  });
});

describe('source rules', () => {
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.(js|html)$/.test(e.name) ? [join(dir, e.name)] : [],
    );
  test('no innerHTML / outerHTML / document.write / inline handlers', () => {
    for (const f of files(root)) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/.test(src), f);
      assert.ok(!/\son[a-z]+="/.test(src), `${f} has an inline event handler`);
    }
  });
  test('every runtime.onMessage listener checks the sender', () => {
    for (const f of files(root).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/onMessage\.addListener\(\(([^)]*)\)\s*=>\s*\{([^]*?)\n/g)) {
        const body = src.slice(m.index, m.index + 300);
        assert.match(body, /isFromThisExtension\(sender\)/, `${f}: listener without sender check`);
      }
    }
  });
  test('tokens are never logged', () => {
    for (const f of files(root).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(f, 'utf8');
      assert.ok(!/console\.\w+\([^)]*\b(token|Authorization|access_token)\b/.test(src), f);
    }
  });
});
