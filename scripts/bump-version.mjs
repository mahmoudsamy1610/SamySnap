#!/usr/bin/env node
// Bump the extension version everywhere it lives and open a CHANGELOG entry.
//   npm run bump -- patch   # 1.1.0 → 1.1.1  (fixes)
//   npm run bump -- minor   # 1.1.0 → 1.2.0  (new features)
//   npm run bump -- major   # 1.1.0 → 2.0.0  (big/breaking changes)
// Updates extension/manifest.json (what Chrome shows) and package.json, and
// adds a "## <version>" section to CHANGELOG.md for you to fill in.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function bump(version, part) {
  const [maj, min, pat] = version.split('.').map(Number);
  if (part === 'major') return `${maj + 1}.0.0`;
  if (part === 'minor') return `${maj}.${min + 1}.0`;
  if (part === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`unknown part "${part}" (use patch | minor | major)`);
}

function main() {
  const part = process.argv[2] || 'patch';
  const manifestPath = join(root, 'extension', 'manifest.json');
  const pkgPath = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const prev = manifest.version;
  const next = bump(prev, part);

  manifest.version = next;
  pkg.version = next;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  const clPath = join(root, 'CHANGELOG.md');
  const cl = existsSync(clPath) ? readFileSync(clPath, 'utf8') : '# Changelog\n';
  const date = new Date().toISOString().slice(0, 10);
  const entry = `## ${next} – ${date}\n\n- TODO: describe the change\n\n`;
  const at = cl.indexOf('\n## ');
  writeFileSync(clPath, at === -1 ? `${cl.trimEnd()}\n\n${entry}` : `${cl.slice(0, at + 1)}${entry}${cl.slice(at + 1)}`);
  console.log(`Version ${prev} → ${next}. Fill in CHANGELOG.md.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
