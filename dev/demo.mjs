// Records docs/demo.gif for the README: what Google stores (only ciphertext),
// then DocLock opening, editing, saving and locking it. Real app, fake Google
// (as in dev/e2e.mjs). Needs the dev server and ffmpeg.
//
//   python3 dev/serve.py &
//   node dev/demo.mjs [http://localhost:8080/]

import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newKey, seal } from '../app/cipher.js';

const url = process.argv[2] || 'http://localhost:8080/';
const out = new URL('../docs/demo.gif', import.meta.url).pathname;
const ID = '1Exampl3DocIdForTests_abcdefghijklmnopqrstu';
const PASS = 'correct horse battery staple';
const APP_W = 820, APP_H = 640, BAR = 40, PAD = 40; // the app at tablet size, so everything reads at GIF size; dark mode
const W = APP_W + 2 * PAD, H = APP_H + BAR + 2 * PAD;

const secret = `Wi-Fi at the cabin: north-ridge-4471

Bank PIN hint: Grandma's street number

Passport: X1234567, expires 2031

Server root: tq8!Vz#2pLm`;
const key = await newKey(PASS);
const doc = { title: 'Secrets', text: '\0' + (await seal(secret, key)) + '\n', rev: 1 };

function asDoc() {
  const content = [{ endIndex: 1, sectionBreak: {} }];
  let i = 1;
  for (const line of doc.text.slice(1).split(/(?<=\n)/)) {
    if (!line) continue;
    content.push({ startIndex: i, endIndex: i + line.length, paragraph: { elements: [{ startIndex: i, endIndex: i + line.length, textRun: { content: line } }] } });
    i += line.length;
  }
  return { documentId: ID, title: doc.title, revisionId: `r${doc.rev}`, tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1' }, documentTab: { body: { content } }, childTabs: [] }] };
}
/** The doc's block as the cards show it: The first lines, how many more there are, and the last. */
function shown() {
  const lines = doc.text.slice(1).trim().split('\n'), head = 23; // about a page's worth
  return [...lines.slice(0, head), `… ${(lines.length - head - 1).toLocaleString('en')} more lines like these …`, lines.at(-1)].join('\n');
}

async function google(route) {
  const req = route.request(), u = new URL(req.url()), json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  if (u.host === 'accounts.google.com') {
    const back = `${u.searchParams.get('redirect_uri')}#${new URLSearchParams({ access_token: 't', expires_in: '3600', scope: u.searchParams.get('scope'), state: u.searchParams.get('state') })}`;
    return route.fulfill({ status: 302, headers: { location: back } });
  }
  if (u.host === 'openidconnect.googleapis.com') return json({ name: 'Alex Doe', email: 'alex@example.com' });
  if (!u.pathname.endsWith(':batchUpdate')) return json(asDoc());
  for (const r of req.postDataJSON().requests) {
    if (r.deleteContentRange) { const { startIndex: s, endIndex: e } = r.deleteContentRange.range; doc.text = doc.text.slice(0, s) + doc.text.slice(e); }
    if (r.insertText) { const at = r.insertText.location.index; doc.text = doc.text.slice(0, at) + r.insertText.text + doc.text.slice(at); }
  }
  doc.rev++;
  return json({ replies: [] });
}

// Scenes on a soft backdrop in the logo's blues (W × H). The app runs in a
// minimal browser window (our own drawing, an iframe of the real app);
// the doc is shown as a plain white A4 page that runs off the bottom (not
// Google's UI).
const backdrop = 'margin:0;height:100vh;overflow:hidden;box-sizing:border-box;background:linear-gradient(135deg,#2b62d9,#7b7ff0);font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif';
const card = (caption, body) => `<body style="${backdrop};display:flex;flex-direction:column;align-items:center;gap:22px;padding-top:30px;color:#fff;font-size:26px;line-height:1.3">
  <div style="font-weight:600;text-shadow:0 1px 8px rgb(0 0 0 / 25%)">${caption}</div>
  <div style="flex:none;width:690px;aspect-ratio:210/297;background:#fff;color:#1d1d1f;box-shadow:0 12px 40px rgb(0 0 0 / 35%);padding:48px 42px;box-sizing:border-box">
    <pre style="margin:0;font:15px/1.55 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all">${body}</pre></div></body>`;
const browserWindow = (src) => `<body style="${backdrop};padding:${PAD}px">
  <div style="width:${APP_W}px;border-radius:12px;overflow:hidden;background:#15161a;box-shadow:0 16px 50px rgb(0 0 0 / 40%)">
    <div style="height:${BAR}px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#2a2c33">
      ${['#ff5f57', '#febc2e', '#28c840'].map((c) => `<span style="width:12px;height:12px;border-radius:50%;background:${c}"></span>`).join('')}
      <div style="flex:1;margin:0 90px 0 60px;height:24px;border-radius:6px;background:#1c1d22;color:#a9abb3;font-size:13px;display:flex;align-items:center;justify-content:center">example.com/doclock/</div>
    </div>
    <iframe name="app" src="${src}" style="display:block;width:${APP_W}px;height:${APP_H}px;border:0"></iframe>
  </div></body>`;

const dir = mkdtempSync(join(tmpdir(), 'doclock-demo-'));
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark', serviceWorkers: 'block', recordVideo: { dir, size: { width: W, height: H } } });
  await ctx.route(/accounts\.google\.com|googleapis\.com/, google);
  // The window page comes from the app's own origin: Web Crypto needs a secure context all the way up.
  const frameUrl = new URL('/__demo-window.html', url).href;
  await ctx.route(frameUrl, (r) => r.fulfill({ contentType: 'text/html', body: browserWindow(url) }));
  const page = await ctx.newPage();
  const pause = (ms) => page.waitForTimeout(ms);

  await page.setContent(card('In your Google Doc, only this', shown()));
  await pause(3500);

  await page.goto(frameUrl);
  const app = page.frame({ name: 'app' });
  await app.waitForSelector('#signin');
  await pause(1500);
  await app.click('#signin');
  await page.frame({ name: 'app' }).waitForSelector('#step-doc:not([hidden])'); // after the sign-in round trip
  const f = page.frame({ name: 'app' });
  await pause(800);
  await f.fill('#link', `https://docs.google.com/document/d/${ID}/edit`); // pasted, all at once
  await pause(1000);
  await f.click('#doc-form button[type=submit]');
  await f.waitForSelector('#step-password:not([hidden])');
  await pause(900);
  await f.type('#password', PASS, { delay: 45 });
  await pause(400);
  await f.click('#password-form button[type=submit]');
  await f.waitForSelector('#step-editor:not([hidden])');
  await pause(2500);
  await f.click('#editor');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nGym locker: 18-04-33', { delay: 55 });
  await pause(700);
  await f.click('#save');
  await f.waitForFunction(() => /Saved/.test(document.getElementById('status-text').textContent));
  await pause(2000);
  await f.click('#lock');
  await pause(1800);

  await page.goto('about:blank');
  await page.setContent(card('Saved back to Google, encrypted again', shown()));
  await pause(3500);
  await ctx.close(); // writes the video
} finally {
  await browser.close();
}

const video = join(dir, readdirSync(dir).find((f) => f.endsWith('.webm')));
const palette = join(dir, 'palette.png'), filters = `fps=10,mpdecimate=hi=2560:lo=960:frac=0.5,scale=${W}:-1:flags=lanczos`; // mpdecimate: A still screen is one frame, not the video's noise
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf', `${filters},palettegen=max_colors=128`, palette]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-i', palette, '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-fps_mode', 'vfr', '-final_delay', '350', out]); // the last card stays 3.5 s
rmSync(dir, { recursive: true });
console.log(`wrote ${out}`);
