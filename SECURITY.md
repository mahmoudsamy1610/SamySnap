# Security review – SamySnap 1.2.1

**Date:** 2026-11-12 · **Scope:** everything shipped in `extension/`, plus the repository and its git history.

## Summary

There are **no critical or high-severity issues**. The extension's attack surface is very small:

- No content scripts.
- No access to websites (host permissions cover only Google APIs).
- No web-accessible resources.
- Not externally connectable.
- No third-party code (no runtime dependencies).

So **no website and no other extension can talk to SamySnap**. The review found 6 hardening items and fixed all of them in 1.2.1.
Two design risks are accepted on purpose (see below).

## How it was checked

| Check | Result |
|---|---|
| Secrets in the code **and the full git history** (private keys, Google client secrets `GOCSPX-`, access tokens `ya29.`, API keys, GitHub tokens) | ✅ None. The only `GOCSPX-` hits are fake strings in tests. The extension private key (`.keys/`) is git-ignored and was never committed. |
| Dependencies / supply chain | ✅ None at runtime. No npm packages are shipped; the extension is plain JS with no build step. |
| Remote code (MV3 rule) | ✅ No `eval`, no `new Function`, no remote scripts. Enforced by tests. |
| Permissions (least privilege) | ✅ `identity, desktopCapture, offscreen, clipboardWrite, storage, notifications`. Hosts: only `www.googleapis.com` and `oauth2.googleapis.com`. No `tabs`, `<all_urls>` or `scripting`. |
| OAuth scope | ✅ Only `drive.file`: SamySnap can see **only the files it created**, never the rest of your Drive. |
| HTML injection (XSS) | ✅ All text is set with `textContent`. Since 1.2.1 there's no `innerHTML` anywhere. Enforced by tests. |
| Token storage | ✅ Access tokens live in `chrome.storage.session`: in memory only, readable only by SamySnap's own pages, wiped when the browser closes, valid for about 1 hour. They're never logged (enforced by tests). |
| Upload session URL (a capability URL) | ✅ Kept in memory in the recorder window only. It's never stored, logged or sent to the popup. |

## Findings fixed in 1.2.1

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Medium | The Google sign-in request had no `state` value, so a forged sign-in response couldn't be told apart from a real one (OAuth CSRF / token injection). | A random 128-bit `state` is sent with each sign-in, and any response that doesn't echo it is rejected. Unit and e2e tests cover this. |
| 2 | Medium | The granted permissions weren't checked. If the user unticked "Drive" on Google's consent screen, SamySnap looked connected but every upload failed. | The granted scopes are checked. Without `drive.file`, you get a clear "tick the Drive box" message and nothing is saved. |
| 3 | Low | Internal message handlers didn't check who sent a message. Nothing outside SamySnap can reach them today; this is defense in depth. | Every `onMessage` listener rejects senders that aren't SamySnap's own pages. A test fails if a new listener skips the check. |
| 4 | Low | Disconnect sent the token in the URL (`/revoke?token=…`), where it can end up in logs. | The token is sent in the POST body instead. |
| 5 | Low | The "Last links" list put stored links straight into `href`. | Links are only clickable if they're real `https://drive.google.com/…` addresses, so `javascript:` and look-alike domains are blocked. |
| 6 | Low | One `innerHTML` with fixed text, and no Content Security Policy declared explicitly (Chrome's default applied). | Rewritten with DOM APIs. Declared a strict CSP: `script-src 'self'; object-src 'none'; base-uri 'none'`. |

## Accepted risks (by design)

1. **Videos are shared as "anyone with the link".** This is what makes the instant link work.
   - The link is unguessable, and the file can't be found by search (`allowFileDiscovery: false`).
   - Anyone you give the link to can watch it, and so can anyone *they* forward it to.
   - **Screen recordings can capture sensitive things** (passwords on screen, emails, chats), so check what's visible before you record.
   - To revoke access later, open the file in Drive → Share → set it to *Restricted*.
   - If your Google Workspace admin blocks public links, SamySnap automatically falls back to a private link and tells you.
2. **The link works before the upload finishes.** Someone who opens it early may see an incomplete video. This is by design, for speed.
3. **The debugging hook `window.samysnapRecorder`** exists in the recorder window. It's reachable only from that window's own DevTools, which already means full control of the browser, so it adds no real risk.
4. **Your own Google sign-in key.** The Client ID you paste isn't a secret (it's public by design for this type of app). It only works with this extension's fixed ID and the redirect link registered in your Google project, and only test users you added can sign in.

## Reporting

Found something? Open a private GitHub security advisory on this repository. Please don't file a public issue.
