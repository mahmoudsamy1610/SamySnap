# Testing

## Manual checklist (real Google Drive)

Do this once after [SETUP.md](SETUP.md), and again after any change.

**Core flow**

- [ ] Click the icon and check that the popup shows **Record** (or **Connect Google Drive** on first run).
- [ ] Click **Record**, choose **Entire screen** in the picker, and click **Share**.
- [ ] The badge shows a red **REC**, the recorder window minimizes, and the popup timer runs.
- [ ] Record for **30 seconds** while moving windows around and playing a sound.
- [ ] Click **Stop & copy link**. A notification says **"Link copied to clipboard."**
- [ ] Paste right away (Ctrl/Cmd+V) into a text field. The link looks like `https://drive.google.com/file/d/…/view`.
- [ ] Open the link in an **incognito window**, where you're not signed in.
  - Right after stopping you may see "video is still being processed" or a partial file. That's expected.
  - Wait for the popup to say **Upload complete**, then wait a minute or so for Drive to process the video. Reload the incognito tab and confirm **the video plays** with audio.
- [ ] In Google Drive, the file is in **Bug Recordings** and named `bug-YYYY-MM-DD_HH-mm-ss.webm`.

**Extras**

- [ ] Press **Alt+Shift+R** to start, and press it again to stop.
- [ ] Start recording, then click Chrome's own **Stop sharing** bar. The link is copied and the upload finishes.
- [ ] Tick **Include microphone**, record while talking, and check that your voice is in the video. You're asked for mic permission the first time.
- [ ] Record a **tab** with "Share tab audio" ticked and check that the tab's sound is in the video.
- [ ] The popup's **Last links** list shows the latest 5 recordings, and **Copy** works for each.
- [ ] Turn off Wi-Fi for about 20 seconds during a recording, then turn it back on. The upload catches up and the file plays completely.
- [ ] Turn off Wi-Fi, stop the recording, and wait about 2 minutes. You get **"Upload failed – your recording is safe"** with **Retry upload** and **Download video** buttons.
  - Download saves the `.webm` locally.
  - Turn Wi-Fi back on and click Retry. The upload completes.

## Automated tests

```bash
npm test            # unit + integration (Node ≥ 20, no dependencies), ~1 s
npm run test:e2e    # real Chromium + the real extension (needs Playwright; uses xvfb on Linux)
npm run test:all    # both
```

| Suite | What it proves |
|---|---|
| `tests/unit/uploader.test.js` | 256 KiB alignment, `bytes a-b/*` vs `bytes a-b/TOTAL`, `bytes */TOTAL`, empty file, strictly one request in flight, backoff and retry, resuming via `bytes */*`, Drive persisting fewer bytes than sent, a lost response to the final chunk, fatal 404/410, `resume()` after giving up. |
| `tests/unit/auth.test.js` | Bearer header; a 401 removes the cached token and retries **once**; the Blob body is re-sent; disconnect/revoke. |
| `tests/unit/drive.test.js` | Folder find/create/cache and re-creation if deleted; empty file in the folder; `anyone/reader/allowFileDiscovery:false`; PATCH session on the same file ID; sharing blocked leads to a warning and a private link; a failed session start deletes the file. |
| `tests/unit/media.test.js` | vp9 → vp8 → webm fallback, 1080p30 and 4 Mbps constraints, Web Audio mixing of system audio and mic. |
| `tests/unit/manifest.test.js` | MV3, **only** the `drive.file` scope, minimal permissions, stable key and ID, every referenced file exists, no remote code. |
| `tests/integration/drive-upload.test.js` | The whole Drive pipeline over **real HTTP** with real `fetch`: 308 handling, token expiry, dropped TCP connections and 5xx errors mid-upload, byte-exact file. |
| `tests/e2e/extension.test.js` | The extension running in real Chromium: real screen capture → MediaRecorder → streaming upload to a fake Drive. Checks the link is on the clipboard when Stop returns, the result is a playable WebM, the REC badge, the history list, the "Stop sharing" bar, the mic mixed in as an Opus track, the admin-blocked sharing warning, recovery from transient errors, and Download after a fatal upload error. |

The e2e tests stub only `chrome.identity` (there's no real Google account in CI) and answer `https://www.googleapis.com` requests with `tests/helpers/fake-drive.js`. That fake **enforces** the resumable protocol rules: alignment, contiguous ranges and matching totals.
