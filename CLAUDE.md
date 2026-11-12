# SamySnap – notes for Claude

Chrome MV3 extension (plain JS, no build step). Extension code is in `extension/`. Tests are in `tests/`.

## Rules

- **Bump the version on every change that touches `extension/`.** Run `npm run bump -- patch` for fixes,
  `minor` for new features and `major` for big changes, then fill in the new `CHANGELOG.md` entry.
  This updates `extension/manifest.json` (what Chrome shows) and `package.json` together.
  `tests/unit/version.test.js` fails if they disagree or the changelog entry is missing.
- Run `npm test` (unit + integration) and `npm run test:e2e` (real Chromium, uses xvfb) before committing.
- Never change the `"key"` in `extension/manifest.json`. The extension ID and the user's Google sign-in depend on it.
- Keep the OAuth scope to `drive.file` only.
