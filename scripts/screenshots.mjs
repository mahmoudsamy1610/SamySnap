// Captures UI screenshots into docs/screenshots (run under a display / xvfb):
//   xvfb-run -a -s "-screen 0 1920x1080x24" node scripts/screenshots.mjs
import { launch, sleep } from '../tests/e2e/harness.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
const shoot = async (page, name) => {
  await page.screenshot({ path: join(out, name), fullPage: true });
  console.log('wrote', name);
};

const errors = [];
const h = await launch({ signedIn: false });
h.sw.on('console', (m) => m.type() === 'error' && errors.push(`[sw] ${m.text()}`));
await h.page.setViewportSize({ width: 340, height: 220 });
await h.page.reload();
await h.page.waitForSelector('#connect-view:not([hidden])');
await shoot(h.page, '1-connect.png');
await h.close();

const r = await launch();
r.sw.on('console', (m) => m.type() === 'error' && errors.push(`[sw] ${m.text()}`));
r.ctx.on('page', (p) => p.on('console', (m) => m.type() === 'error' && errors.push(`[${p.url()}] ${m.text()}`)));
await r.page.setViewportSize({ width: 340, height: 420 });
await r.page.reload();
await r.page.waitForSelector('#main-view:not([hidden])');
await shoot(r.page, '2-ready.png');

await r.send('start');
await r.waitState((s) => s.phase === 'recording');
const rec = r.recorderPage();
await rec.evaluate(() => chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { state: 'normal' })));
await sleep(3200);
await rec.setViewportSize({ width: 480, height: 300 });
await shoot(rec, '4-recorder-window.png');
await r.page.bringToFront();
await r.page.reload();
await r.page.waitForSelector('#main-view:not([hidden])');
await shoot(r.page, '3-recording.png');

await r.send('stop');
await r.waitState((s) => s.phase === 'done');
for (let i = 0; i < 2; i++) {
  await r.send('start');
  await r.waitState((s) => s.phase === 'recording');
  await sleep(1200);
  await r.send('stop');
  await r.waitState((s) => s.phase === 'done');
}
await r.page.reload();
await r.page.waitForSelector('#history li');
await shoot(r.page, '5-done-history.png');

r.drive.shareBlocked = true;
await r.send('start');
await r.waitState((s) => s.phase === 'recording');
r.drive.fault(410, { times: 50 });
await sleep(1500);
await r.send('stop');
await r.waitState((s) => s.phase === 'error');
await r.page.reload();
await r.page.waitForSelector('#error-box:not([hidden])');
await shoot(r.page, '6-upload-failed.png');
await r.close();
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
