// PNG app icons from app/logo.svg, for the web app manifest and iOS.
//
//   node dev/icons.mjs
//
// icon-192/512: the logo on transparent. icon-maskable-512 and
// apple-touch-icon (180): on white, inside the safe zone,
// because Android crops maskable icons and iOS fills transparency with black.

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const app = new URL('../app/', import.meta.url).pathname;
const svg = 'data:image/svg+xml;base64,' + readFileSync(`${app}logo.svg`).toString('base64');
// The drawing's bounds inside the SVG's 1114 × 1200 canvas.
const box = { x: 178, y: 83, w: 758, h: 1043 };

const icons = [
  ['icon-192.png', 192, 0.9, null],
  ['icon-512.png', 512, 0.9, null],
  ['icon-maskable-512.png', 512, 0.637, '#ffffff'], // sized and coloured like Google Docs' own icon on Android
  ['apple-touch-icon.png', 180, 0.7, '#ffffff'],
];

const browser = await chromium.launch();
try {
  for (const [file, size, fill, bg] of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const scale = (size * fill) / box.h; // the drawing is taller than wide
    const left = (size - box.w * scale) / 2 - box.x * scale, top = (size - box.h * scale) / 2 - box.y * scale;
    await page.setContent(`<body style="margin:0;width:${size}px;height:${size}px;overflow:hidden;background:${bg || 'transparent'}">
      <img src="${svg}" style="position:absolute;left:${left}px;top:${top}px;width:${1114 * scale}px;height:${1200 * scale}px"></body>`);
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${app}${file}`, omitBackground: !bg });
    await page.close();
    console.log(file);
  }
} finally {
  await browser.close();
}
