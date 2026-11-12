// Guards the release hygiene: one version everywhere, with a changelog entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bump } from '../../scripts/bump-version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

test('manifest and package.json have the same version', () => {
  assert.equal(manifest.version, pkg.version);
});

test('version is a valid Chrome version (x.y.z)', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('CHANGELOG has a filled-in entry for the current version', () => {
  const m = new RegExp(`## ${manifest.version.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(\\n## |$)`).exec(changelog);
  assert.ok(m, `CHANGELOG.md has no "## ${manifest.version}" section`);
  assert.ok(!/TODO/.test(m[1]), 'CHANGELOG entry still says TODO');
  assert.ok(m[1].trim().length > 0);
});

test('bump()', () => {
  assert.equal(bump('1.1.0', 'patch'), '1.1.1');
  assert.equal(bump('1.1.9', 'minor'), '1.2.0');
  assert.equal(bump('1.4.2', 'major'), '2.0.0');
  assert.throws(() => bump('1.0.0', 'huge'));
});
