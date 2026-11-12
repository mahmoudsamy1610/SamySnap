# Changelog

The version shown in `chrome://extensions` (and in the popup) comes from `extension/manifest.json`.
Bump it with `npm run bump -- patch|minor|major` for every change.

## 1.3.1 – 2026-11-12

- **More reliable watermark:**
  - A second drawing method works on Chrome versions without the newer frame-processing API, and keeps running while the recorder window is minimized.
  - If drawing a frame ever fails, the original frame is recorded instead of freezing the video.
- **No silent failures:** if the watermark can't be added, a notification and a popup warning say so.
- While recording, the popup shows **"Watermark on"** when it's active.

## 1.3.0 – 2026-11-12

- **Watermark:** turn on "Add watermark" in the popup to burn the SamySnap logo, your own text and an optional live date & time into the video.
  - You choose the corner.
  - It's semi-transparent with a soft shadow, so it's readable on any background.
  - It keeps working while the recorder window is minimized.
- **Screenshot → clipboard:** press **Ctrl+Shift+7** (⌘⇧7 on Mac) or click the camera button in the popup.
  - Captures the current tab and copies the image straight to your clipboard. Just paste.
  - A small "Screenshot copied ✓" preview shows for 2 seconds, with a "Save as file" option.
- New `activeTab` permission, used only for screenshots. Chrome grants it for the current tab only, and only when you press the shortcut or click the icon.

## 1.2.1 – 2026-11-12

- **New shortcuts:** **Ctrl+Shift+9** starts and stops recording, and **Ctrl+Shift+8** pauses (⌘⇧9 / ⌘⇧8 on Mac).
  - The old Alt+Shift keys clashed with the Windows keyboard-language switch and with a reading feature.
  - The popup shows the active shortcut; click it to change shortcuts.
- **Security hardening** (see `SECURITY.md`):
  - Google sign-in now uses a random `state` value and checks it, so a forged sign-in response is rejected.
  - Checks that Google actually granted Drive access. If the box was unticked, you get a clear message instead of failing later.
  - Every internal message checks that it comes from SamySnap itself.
  - Disconnect sends the token in the request body instead of the URL.
  - Links are only clickable if they are real `https://drive.google.com` links.
  - No HTML is built from strings.
  - An explicit strict Content Security Policy is declared.

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
