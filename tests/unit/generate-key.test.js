import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { extensionIdFromKey } from '../../scripts/generate-key.mjs';

test('extension id matches the algorithm Chrome uses (sha256 → a-p), cross-checked with openssl', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const id = extensionIdFromKey(der.toString('base64'));
  assert.match(id, /^[a-p]{32}$/);

  // independent computation with the openssl CLI (if available)
  let hex;
  try {
    hex = execFileSync('openssl', ['dgst', '-sha256', '-hex'], { input: der }).toString().split('= ')[1].trim();
  } catch {
    return; // openssl not installed – the regex check above still ran
  }
  const expected = [...hex.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  assert.equal(id, expected);
});

test('deterministic for the same key', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(extensionIdFromKey(b64), extensionIdFromKey(b64));
});
