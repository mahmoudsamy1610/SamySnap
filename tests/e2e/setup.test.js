// The setup guide: opens on install, walks through the steps, validates and
// saves the pasted Client ID, signs in (stubbed Google) and lands on "All set".
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { launch, sleep, TEST_CLIENT_ID } from './harness.js';

const open = [];
afterEach(async () => {
  while (open.length) await open.pop().close().catch(() => {});
});
async function start(opts) {
  const h = await launch(opts);
  open.push(h);
  return h;
}

async function waitForSetupTab(h, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const p = h.setupPage();
    if (p) {
      await p.waitForLoadState();
      return p;
    }
    await sleep(100);
  }
  throw new Error('setup tab did not open');
}

const visibleStep = (p) => p.$eval('.step:not([hidden])', (el) => Number(el.dataset.step));

describe('setup guide', { timeout: 60_000 }, () => {
  test('opens automatically on first install', async () => {
    const h = await start({ configured: false });
    const setup = await waitForSetupTab(h);
    await setup.waitForSelector('.step[data-step="0"]:not([hidden])');
    assert.match(await setup.textContent('h2'), /Connect SamySnap to your Google Drive/);
  });

  test('popup "Start setup" opens the guide', async () => {
    const h = await start({ configured: false });
    for (const p of h.ctx.pages()) if (p.url().includes('/setup/')) await p.close();
    await h.page.reload();
    await h.page.click('#open-setup');
    const setup = await waitForSetupTab(h);
    assert.ok(setup.url().endsWith('/setup/setup.html'));
  });

  test('Record without setup opens the guide instead of failing', async () => {
    const h = await start({ configured: false });
    for (const p of h.ctx.pages()) if (p.url().includes('/setup/')) await p.close();
    const res = await h.send('start');
    assert.equal(res.ok, false);
    assert.equal(res.needsSetup, true);
    await waitForSetupTab(h);
  });

  test('walks through all steps with progress; every step links to a Google page', async () => {
    const h = await start({ configured: false });
    const setup = await waitForSetupTab(h);
    assert.equal(await visibleStep(setup), 0);
    assert.equal(await setup.isHidden('#progress'), true);
    await setup.click('#next');
    for (let step = 1; step <= 5; step++) {
      assert.equal(await visibleStep(setup), step);
      assert.equal(await setup.textContent('#progress-label'), `Step ${step} of 6`);
      const href = await setup.$eval('.step:not([hidden]) .open-btn', (a) => a.href);
      assert.match(href, /^https:\/\/console\.cloud\.google\.com\//);
      await setup.click('#next');
    }
    assert.equal(await visibleStep(setup), 6);
    assert.equal(await setup.isHidden('#next'), true, 'step 6 uses the Connect button');
    await setup.click('#back');
    assert.equal(await visibleStep(setup), 5);
  });

  test('remembers the step when reopened', async () => {
    const h = await start({ configured: false });
    const setup = await waitForSetupTab(h);
    await setup.click('#next');
    await setup.click('#next');
    await setup.click('#next');
    await setup.reload();
    await setup.waitForSelector('.step[data-step="3"]:not([hidden])');
  });

  test('step 5 shows this extension’s exact redirect link and copies it', async () => {
    const h = await start({ configured: false });
    const setup = await waitForSetupTab(h);
    await setup.goto(h.url('setup/setup.html?step=5'));
    const expected = `https://${h.extId}.chromiumapp.org/`;
    await setup.waitForFunction((e) => document.getElementById('redirect-uri').textContent === e, expected);
    await setup.click('#redirect-chip');
    assert.equal(await setup.evaluate(() => navigator.clipboard.readText()), expected);
    assert.match(await setup.textContent('#redirect-chip span'), /Copied/);
  });

  test('copy chips copy the app name', async () => {
    const h = await start({ configured: false });
    const setup = await waitForSetupTab(h);
    await setup.goto(h.url('setup/setup.html?step=1'));
    await setup.click('.step[data-step="1"] .chip');
    assert.equal(await setup.evaluate(() => navigator.clipboard.readText()), 'SamySnap');
  });

  test('rejects a wrong value (e.g. the client secret) with a friendly hint', async () => {
    const h = await start({ configured: false });
    const setup = await waitForSetupTab(h);
    await setup.goto(h.url('setup/setup.html?step=6'));
    await setup.fill('#client-id', 'GOCSPX-thisIsTheSecretNotTheId');
    assert.match(await setup.textContent('#client-id-hint'), /doesn’t look like a Client ID/);
    await setup.click('#connect');
    assert.equal(await visibleStep(setup), 6);
    assert.equal(await h.local('googleClientId'), undefined);
  });

  test('paste key → Connect → "All set"; popup is then ready to record', async () => {
    const h = await start({ configured: false });
    const setup = await waitForSetupTab(h);
    await setup.goto(h.url('setup/setup.html?step=6'));
    // messy paste: label + quotes + whitespace
    await setup.fill('#client-id', `Client ID: "${TEST_CLIENT_ID}" `);
    assert.match(await setup.textContent('#client-id-hint'), /Looks right/);
    await setup.click('#connect');
    await setup.waitForSelector('.step[data-step="7"]:not([hidden])');
    assert.match(await setup.textContent('.step[data-step="7"] h2'), /all set/i);

    assert.equal(await h.local('googleClientId'), TEST_CLIENT_ID);
    assert.equal(await h.local('driveConnected'), true);
    // connecting also prepared the "Bug Recordings" folder
    await sleep(500);
    assert.ok([...h.drive.files.values()].some((f) => f.name === 'Bug Recordings'));

    await h.page.reload();
    await h.page.waitForSelector('#main-view:not([hidden])');
    assert.equal(await h.page.textContent('#toggle-label'), 'Record');
  });

  test('closing the Google window shows a clear message and stays on the step', async () => {
    const h = await start({ configured: false });
    const setup = await waitForSetupTab(h);
    await h.setAuth('deny');
    await setup.goto(h.url('setup/setup.html?step=6'));
    await setup.fill('#client-id', TEST_CLIENT_ID);
    await setup.click('#connect');
    await setup.waitForSelector('#connect-error:not([hidden])');
    assert.match(await setup.textContent('#connect-error'), /Google window was closed/);
    assert.equal(await visibleStep(setup), 6);
    assert.equal(await setup.textContent('#connect'), 'Connect Google Drive');
  });

  test('"start over" forgets the key and goes back to step 1', async () => {
    const h = await start();
    await h.page.goto(h.url('setup/setup.html'));
    await h.page.waitForSelector('.step[data-step="7"]:not([hidden])'); // already connected → All set
    await h.page.click('#start-over');
    await h.page.waitForSelector('.step[data-step="1"]:not([hidden])');
    assert.equal(await h.local('googleClientId'), undefined);
    assert.equal(await h.local('driveConnected'), undefined);
  });
});
