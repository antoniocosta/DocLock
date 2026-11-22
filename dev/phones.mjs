// The phone picture for the README (docs/phones.png): The password screen,
// the editor in Preview (dark mode) and the decoy screen, as the installed
// app, in plain phone outlines on the same backdrop as the animation (dev/demo.mjs). No
// sign-in: The page is loaded from the dev server and shown with sample
// content.
//
//   python3 dev/serve.py &      # http://localhost:8080
//   node dev/phones.mjs [http://localhost:8080/]

import { chromium, devices } from '@playwright/test';

const url = process.argv[2] || 'http://localhost:8080/';
const docs = new URL('../docs/', import.meta.url).pathname;
const text = `# Home

**Wi-Fi at the cabin:** north-ridge-4471
**Alarm code:** 4471, then the green key

## Recovery codes

- [x] Email: 8842 1930
- [ ] Bank: 5521 7764
- [ ] Phone: 0937 4418

> Passport X1234567, expires 2031

Server root: \`tq8!Vz#2pLm\``;

// Puts one screen on show with sample content (runs in the browser).
async function stage({ screen, text }) {
  const $ = (id) => document.getElementById(id);
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== `step-${screen}`;
  $('progress').hidden = screen !== 'password';
  $('progress').firstChild.style.width = '66%';
  $('status').className = 'snackbar';
  if (screen === 'password') {
    $('password-doc').textContent = 'The password for “Secrets”.';
    $('password').value = 'correct horse battery';
  } else if (screen === 'decoy') {
    $('decoy-pass').type = 'text';
    $('decoy-pass').value = 'My first bike, was red!';
    $('decoy-text').value = 'Old wallet\n5Kb8kLf9zgWQnogidDA76MzPL6TsZZY36hWXMssSzNydYXYB9KF';
  } else { // the editor, in Preview
    $('doc-title').textContent = 'Secrets';
    $('doc-state').textContent = `${text.length.toLocaleString()} characters`;
    $('save').textContent = 'Saved';
    $('save').classList.add('saved');
    $('save').disabled = true;
    $('editor').hidden = true;
    $('preview').hidden = false;
    $('view-preview').setAttribute('aria-checked', true);
    for (const b of $('md-actions').querySelectorAll('button')) b.disabled = true;
    $('preview').innerHTML = (await import('./markdown.js')).render(text); // the app's own renderer
  }
}

// One phone: Our own drawing around a screenshot of the real app. The strip on top is the system's
// status bar, which an installed app draws under in its own colours. All to the phone's real proportions.
const W = 900, H = 660, PHONE_W = 250;
const phone = (shot, { width, height }, [bg, fg]) => `<div style="padding:6px;border-radius:38px;background:#2a2c33;box-shadow:0 16px 50px rgb(0 0 0 / 40%)">
  <div style="width:${PHONE_W}px;border-radius:32px;overflow:hidden;background:${bg}">
    <div style="position:relative;height:38px;display:flex;align-items:center;justify-content:space-between;padding:0 25px;color:${fg};font:600 11px -apple-system,Segoe UI,Roboto,Arial,sans-serif">
      <span>9:41</span><span style="position:absolute;left:50%;top:8px;width:80px;height:23px;margin-left:-40px;border-radius:12px;background:#000"></span>
      <span style="display:flex;align-items:center;gap:1px"><span style="width:21px;height:10px;border:1px solid ${fg};border-radius:3px;padding:1px;box-sizing:border-box;opacity:.9"><span style="display:block;width:80%;height:100%;border-radius:1.5px;background:${fg}"></span></span><span style="width:1.5px;height:4px;border-radius:0 1px 1px 0;background:${fg};opacity:.9"></span></span></div>
    <img src="data:image/png;base64,${shot}" style="display:block;width:${PHONE_W}px;height:${Math.round(PHONE_W * height / width)}px">
    <div style="height:22px;display:flex;justify-content:center;align-items:center"><span style="width:88px;height:4px;border-radius:2px;background:${fg};opacity:.55"></span></div>
  </div></div>`;

const browser = await chromium.launch();
try {
  const phones = [];
  const light = ['#f5f3ef', '#1d1d1f'], dark = ['#15161a', '#e9e9ee'];
  for (const [screen, scheme, colours] of [['password', 'light', light], ['editor', 'dark', dark], ['decoy', 'light', light]]) {
    const device = { ...devices['iPhone 15'], viewport: { width: 393, height: 759 } }; // an iPhone 15 is 393 × 852: The page, less the status bar (59) and the home bar (34)
    const ctx = await browser.newContext({ ...device, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForTimeout(600);
    await page.evaluate(`(${stage})(${JSON.stringify({ screen, text })})`);
    await page.waitForTimeout(700); // the step animation
    phones.push(phone((await page.screenshot()).toString('base64'), device.viewport, colours));
    await ctx.close();
  }
  const sheet = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await sheet.setContent(`<body style="margin:0;height:100vh;box-sizing:border-box;background:linear-gradient(135deg,#2b62d9,#7b7ff0);display:flex;justify-content:center;align-items:center;gap:36px">${phones.join('')}</body>`);
  await sheet.screenshot({ path: `${docs}phones.png` });
  console.log('phones.png');
} finally {
  await browser.close();
}
