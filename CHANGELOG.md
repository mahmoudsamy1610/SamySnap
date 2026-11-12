# Changelog

The version shown in `chrome://extensions` (and in the popup) comes from `extension/manifest.json`.
Bump it with `npm run bump -- patch|minor|major` for every change.

## 1.2.0 – 2026-11-12

- **Pause / resume recording:** from the popup, the recorder window, or the new **Alt+Shift+P** shortcut.
  - While paused, nothing is recorded, but what's already recorded keeps uploading.
  - The timer freezes and the badge turns into an amber **II**.
  - The final video skips the paused part.
  - Stop works while paused, and the link is still copied instantly.

## 1.1.0 – 2026-11-12

- **Setup guide:** a step-by-step page opens on install, with a button to the right Google page for each step and Copy buttons. You paste your key into the guide; there's no editing of `manifest.json`.
- **Easier sign-in:** uses the pasted Client ID (Google "Web application" client) through `launchWebAuthFlow`. Tokens refresh silently.
- **Popup:** shows "Start setup" until Google Drive is set up, and shows the version number.
- **New logo** and app icons at every size.
- **Bigger screen picker:** the "Choose what to share" dialog opens full size (1000×760) instead of squeezed. The window shrinks and minimizes once recording starts.

## 1.0.0 – 2026-11-12

- First version: record the entire screen, a window or a tab, and stream it into Google Drive while recording. The share link is copied the instant you stop.
- Uploads in 256 KiB chunks with retry, backoff and resume. You can download the video locally if the upload fails.
- REC badge, Alt+Shift+R shortcut, notification, last 5 links, optional microphone.
