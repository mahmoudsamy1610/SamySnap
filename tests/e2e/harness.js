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

/**
 * @param {{signedIn?: boolean, drive?: FakeDrive}} [opts]
 */
export async function launch({ signedIn = true, drive = new FakeDrive({ base: 'https://www.googleapis.com' }) } = {}) {
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !hasDisplay,
    viewport: null,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--auto-select-desktop-capture-source=Entire screen',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--window-size=1280,800',
    ],
  });

  if (signedIn) {
    await ctx.addInitScript(() => {
      if (location.protocol === 'chrome-extension:' && globalThis.chrome?.identity) {
        chrome.identity.getAuthToken = async () => ({ token: 'tok-1', grantedScopes: [] });
        chrome.identity.removeCachedAuthToken = async () => {};
      }
    });
  }

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
  if (signedIn) {
    await sw.evaluate(() => {
      chrome.identity.getAuthToken = async () => ({ token: 'tok-1', grantedScopes: [] });
      chrome.identity.removeCachedAuthToken = async () => {};
    });
  }
  const extId = new URL(sw.url()).host;
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);

  // A normal page we drive the extension from (stands in for the popup).
  const page = ctx.pages()[0] ?? (await ctx.newPage());
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
