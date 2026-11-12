// Builds the SamySnap logo: SVG masters + every PNG size, rendered by Chromium.
//   node scripts/build-logo.mjs
//
// Design: a warm red squircle; white "screen capture" corner brackets frame a
// record button (white ring + red dot). Sizes ≤ 32 px use a simplified mark
// (no brackets, bigger button) so the toolbar icon stays crisp.

import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)('playwright');

const RED_TOP = '#FF6B4A';
const RED_BOTTOM = '#E0262F';
const DOT = '#E8342C';

const defs = (id) => `
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${RED_TOP}"/>
      <stop offset="1" stop-color="${RED_BOTTOM}"/>
    </linearGradient>
    <radialGradient id="${id}-shine" cx="0.3" cy="0.2" r="0.9">
      <stop offset="0" stop-color="#fff" stop-opacity="0.22"/>
      <stop offset="0.6" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
  </defs>`;

/** Full mark (48 px and up). 128×128 viewBox. */
export const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">${defs('g')}
  <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#g)"/>
  <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#g-shine)"/>
  <g fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M28 46V36a8 8 0 0 1 8-8h10"/>
    <path d="M82 28h10a8 8 0 0 1 8 8v10"/>
    <path d="M100 82v10a8 8 0 0 1-8 8H82"/>
    <path d="M46 100H36a8 8 0 0 1-8-8V82"/>
  </g>
  <circle cx="64" cy="64" r="22" fill="#fff"/>
  <circle cx="64" cy="64" r="13" fill="${DOT}"/>
</svg>`;

/** Simplified mark for 16/32 px: no brackets, bigger button. */
export const iconSmallSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">${defs('s')}
  <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="url(#s)"/>
  <circle cx="16" cy="16" r="9.5" fill="#fff"/>
  <circle cx="16" cy="16" r="5.5" fill="${DOT}"/>
</svg>`;

/** Horizontal logo: mark + wordmark. */
const wordmark = (textColor) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 128" width="520" height="128">${defs('w')}
  <g>
    <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#w)"/>
    <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#w-shine)"/>
    <g fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M28 46V36a8 8 0 0 1 8-8h10"/><path d="M82 28h10a8 8 0 0 1 8 8v10"/>
      <path d="M100 82v10a8 8 0 0 1-8 8H82"/><path d="M46 100H36a8 8 0 0 1-8-8V82"/>
    </g>
    <circle cx="64" cy="64" r="22" fill="#fff"/><circle cx="64" cy="64" r="13" fill="${DOT}"/>
  </g>
  <text x="150" y="84" font-family="Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="64" font-weight="800" letter-spacing="-1.5" fill="${textColor}">Samy<tspan fill="${RED_BOTTOM}">Snap</tspan></text>
</svg>`;

async function main() {
  mkdirSync(join(root, 'docs', 'brand'), { recursive: true });
  const files = {
    'extension/icons/logo.svg': iconSvg,
    'extension/icons/logo-small.svg': iconSmallSvg,
    'docs/brand/logo-mark.svg': iconSvg,
    'docs/brand/logo-wordmark.svg': wordmark('#1f2328'),
    'docs/brand/logo-wordmark-dark.svg': wordmark('#ffffff'),
  };
  for (const [p, svg] of Object.entries(files)) writeFileSync(join(root, p), svg + '\n');

  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  async function render(svg, w, h, out, bg = 'transparent') {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(
      `<html><body style="margin:0;background:${bg}">${svg.replace(/width="\d+" height="\d+"/, `width="${w}" height="${h}"`)}</body></html>`,
    );
    await page.screenshot({ path: join(root, out), omitBackground: bg === 'transparent', clip: { x: 0, y: 0, width: w, height: h } });
    console.log('wrote', out);
  }
  for (const s of [16, 32]) await render(iconSmallSvg, s, s, `extension/icons/icon${s}.png`);
  for (const s of [48, 128]) await render(iconSvg, s, s, `extension/icons/icon${s}.png`);
  await render(iconSvg, 512, 512, 'docs/brand/logo-512.png'); // Chrome Web Store / sharing
  await render(wordmark('#1f2328'), 1040, 256, 'docs/brand/logo-wordmark.png');
  await render(wordmark('#ffffff'), 1040, 256, 'docs/brand/logo-wordmark-dark.png', '#1e1f22');

  // Preview sheet: all sizes on light + dark toolbars.
  await page.setViewportSize({ width: 720, height: 300 });
  const img = (s) => `<img src="file://${join(root, 'extension/icons', `icon${s}.png`)}" width="${s}" height="${s}">`;
  const row = (bg, fg) => `<div style="display:flex;gap:28px;align-items:end;padding:22px 28px;background:${bg};color:${fg};font:12px system-ui">
    ${[16, 32, 48, 128].map((s) => `<div style="text-align:center">${img(s)}<div>${s}px</div></div>`).join('')}
    <div style="margin-left:auto;display:flex;align-items:center;gap:8px;background:${bg === '#fff' ? '#f1f3f4' : '#35363a'};padding:6px 10px;border-radius:16px">${img(16)} <span>toolbar</span></div></div>`;
  await page.goto(`file://${join(root, 'docs/brand')}/`);
  await page.setContent(`<html><body style="margin:0">${row('#fff', '#333')}${row('#202124', '#ddd')}</body></html>`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(root, 'docs/brand/preview.png'), fullPage: true });
  console.log('wrote docs/brand/preview.png');
  await browser.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
