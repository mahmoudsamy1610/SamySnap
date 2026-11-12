// Launches real Chromium with the unpacked extension and wires it to a fake
// Google Drive:
//   * chrome.identity.getAuthToken is stubbed (no real Google account in CI),
//   * every request to https://www.googleapis.com is answered by FakeDrive,
//   * the native screen picker auto-selects "Entire screen".
// Needs a display (headed Chrome): on Linux CI run under xvfb (see scripts/run-e2e.sh).

import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeDrive } from '../helpers/fake-drive.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY);

/** A page full of moving noise so the screen recording has real bitrate (> 256 KiB). */
const NOISE_PAGE = `data:text/html,<body style="margin:0;background:#000"><canvas id=c width=1280 height=720 style="width:100vw;height:100vh"></canvas><script>
const c=document.getElementById('c').getContext('2d');const img=c.createImageData(1280,720);
(function f(){const d=img.data;for(let i=0;i<d.length;i+=4){const v=Math.random()*255|0;d[i]=v;d[i+1]=(v*7)&255;d[i+2]=(v*13)&255;d[i+3]=255}c.putImageData(img,0,0);requestAnimationFrame(f)})();</script></body>`;

export const TEST_CLIENT_ID = '1234567890-samysnaptest.apps.googleusercontent.com';

/**
 * Stub for chrome.identity.launchWebAuthFlow (no real Google in tests).
 * Behaviour is switched at runtime through chrome.storage.local.__testAuth:
 *   'ok' (default) → returns a token; 'deny' → user closed the window.
 */
function installAuthStub() {
  if (!globalThis.chrome?.identity) return;
  chrome.identity.launchWebAuthFlow = async ({ url, interactive }) => {
    const mode = (await chrome.storage.local.get('__testAuth')).__testAuth || 'ok';
    if (mode === 'deny') throw new Error(interactive ? 'The user did not approve access.' : 'User interaction required.');
    const req = new URL(url).searchParams;
    // Like Google: echo `state`; 'noscope' = user unticked the Drive permission.
    const scope = mode === 'noscope' ? 'openid' : req.get('scope');
    const state = mode === 'badstate' ? 'forged' : req.get('state');
    return `${chrome.identity.getRedirectURL()}#access_token=tok-1&token_type=Bearer&expires_in=3599&scope=${encodeURIComponent(scope)}&state=${state}`;
  };
}

/**
 * @param {{configured?: boolean, autoPick?: boolean, drive?: FakeDrive}} [opts]
 *   autoPick=false → Chrome's real screen picker stays open (for visual checks).
 *   configured=true  → behaves like a user who finished the setup guide and connected.
 *   configured=false → a fresh install (setup guide not done).
 */
export async function launch({ configured = true, signedIn, autoPick = true, drive = new FakeDrive({ base: 'https://www.googleapis.com' }) } = {}) {
  if (signedIn !== undefined) configured = signedIn; // backwards-compatible option name
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !hasDisplay,
    viewport: null,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      ...(autoPick ? ['--auto-select-desktop-capture-source=Entire screen'] : []),
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });

  await ctx.addInitScript(installAuthStub); // only does something on extension pages

  const driveFetch = drive.asFetch();
  await ctx.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const buf = req.postDataBuffer();
    try {
      const res = await driveFetch(req.url(), {
        method: req.method(),
        headers: req.headers(),
        body: buf ? new Uint8Array(buf) : undefined,
      });
      await route.fulfill({
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: Buffer.from(await res.arrayBuffer()),
      });
    } catch {
      await route.abort('connectionreset');
    }
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate(installAuthStub);
  const extId = new URL(sw.url()).host;
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);

  if (configured) {
    await sw.evaluate(
      (clientId) => chrome.storage.local.set({ googleClientId: clientId, driveConnected: true }),
      TEST_CLIENT_ID,
    );
    // The first-install setup tab may have opened before we configured – close it.
    await sleep(300);
    for (const p of ctx.pages()) if (p.url().includes('/setup/setup.html')) await p.close();
  }

  // A normal page we drive the extension from (stands in for the popup).
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup/popup.html`);

  const h = {
    ctx,
    sw,
    extId,
    page,
    drive,
    url: (p) => `chrome-extension://${extId}/${p}`,
    send: (type, extra = {}) =>
      page.evaluate(([type, extra]) => chrome.runtime.sendMessage({ target: 'background', type, ...extra }), [type, extra]),
    state: () => page.evaluate(async () => (await chrome.storage.session.get('recState')).recState ?? { phase: 'idle' }),
    local: (key) => page.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key),
    badge: () => sw.evaluate(() => chrome.action.getBadgeText({})),
    clipboard: async () => {
      await page.bringToFront();
      return page.evaluate(() => navigator.clipboard.readText());
    },
    /** Wait until the shared state satisfies `pred`. */
    async waitState(pred, { timeout = 20_000, label = 'state' } = {}) {
      const end = Date.now() + timeout;
      let s;
      while (Date.now() < end) {
        s = await h.state();
        if (pred(s)) return s;
        await sleep(200);
      }
      throw new Error(`timeout waiting for ${label}; last state: ${JSON.stringify(s)}`);
    },
    recorderPage: () => ctx.pages().find((p) => p.url().includes('/recorder/recorder.html')),
    setupPage: () => ctx.pages().find((p) => p.url().includes('/setup/setup.html')),
    setAuth: (mode) => page.evaluate((m) => chrome.storage.local.set({ __testAuth: m }), mode),
    async openNoise() {
      const p = await ctx.newPage();
      await p.goto(NOISE_PAGE);
      await p.bringToFront();
      return p;
    },
    close: () => ctx.close(),
  };
  return h;
}
