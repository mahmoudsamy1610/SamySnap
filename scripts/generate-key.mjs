#!/usr/bin/env node
// Generates the manifest "key" so the extension ID never changes (the Google
// OAuth client is tied to that ID).
//
//   node scripts/generate-key.mjs            # create a key if manifest has none
//   node scripts/generate-key.mjs --force    # replace the key (NEW extension ID!)
//   node scripts/generate-key.mjs --print    # just print the current extension ID
//
// The private key is written to .keys/extension-key.pem (git-ignored). You only
// need it if you ever want to pack a .crx; for "Load unpacked" the public key
// in manifest.json is all Chrome needs.
//
// Equivalent with openssl:
//   openssl genrsa 2048 > key.pem
//   openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A   # → manifest "key"

import { generateKeyPairSync, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'extension', 'manifest.json');

/** Chrome extension ID = first 32 hex chars of sha256(DER public key), 0-f mapped to a-p. */
export function extensionIdFromKey(base64Der) {
  const hash = createHash('sha256').update(Buffer.from(base64Der, 'base64')).digest('hex').slice(0, 32);
  return [...hash].map((ch) => String.fromCharCode('a'.charCodeAt(0) + parseInt(ch, 16))).join('');
}

function main() {
  const args = new Set(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  if (args.has('--print') || (manifest.key && !args.has('--force'))) {
    if (!manifest.key) throw new Error('manifest.json has no "key" yet – run without --print');
    console.log(`Extension ID: ${extensionIdFromKey(manifest.key)}`);
    if (!args.has('--print')) console.log('(manifest already has a key; use --force to replace it)');
    return;
  }

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  mkdirSync(join(root, '.keys'), { recursive: true });
  const pemPath = join(root, '.keys', 'extension-key.pem');
  if (existsSync(pemPath) && !args.has('--force')) throw new Error(`${pemPath} exists; use --force`);
  writeFileSync(pemPath, pem, { mode: 0o600 });

  manifest.key = der;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote "key" to extension/manifest.json and private key to .keys/extension-key.pem`);
  console.log(`Extension ID: ${extensionIdFromKey(der)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
