// Clicks through every DocLock flow in a real browser against a fake Google
// (sign-in redirect and popup, Docs and Drive APIs), checking what the user
// sees and what ends up in the "Google Doc". Needs the dev server.
//
//   python3 dev/serve.py &      # http://localhost:8080
//   node dev/e2e.mjs [http://localhost:8080/]

import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readEncryptedDoc } from '../app/docmodel.js';
import { newKey, seal, unlock, START } from '../app/cipher.js';
import { tamper } from './tamper.mjs';

const url = process.argv[2] || 'http://localhost:8080/';
const D1 = '1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', D2 = '1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PASS = 'correct horse battery';
const key = await newKey(PASS);
const SCOPE = 'openid email profile https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file';

// ---- fake Google: docs held as plain text, index i = character i (0 = section break)
const docs = new Map();
let nextId = 1, fail401 = 0;
const addDoc = (id, title, text) => docs.set(id, { title, text: '\0' + text, rev: 1, versions: [] }); // versions: every text the doc has held, like Google's history
function asDoc(id) {
  const d = docs.get(id), content = [{ endIndex: 1, sectionBreak: {} }];
  let i = 1;
  for (const line of d.text.slice(1).split(/(?<=\n)/)) {
    if (!line) continue;
    content.push({ startIndex: i, endIndex: i + line.length, paragraph: { elements: [{ startIndex: i, endIndex: i + line.length, textRun: { content: line } }] } });
    i += line.length;
  }
  return { documentId: id, title: d.title, revisionId: `r${d.rev}`, tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1' }, documentTab: { body: { content } }, childTabs: [] }] };
}
const docText = async (id, pass = PASS) => (await unlock(readEncryptedDoc(asDoc(id), null).block.armoured, pass)).result.text;
const body = (text) => text.split('\n').filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l)); // the block's base64 lines
const editElsewhere = async (id, text) => { const d = docs.get(id); d.text = '\0' + (await seal(text, key)) + '\n'; d.rev++; };
addDoc(D1, 'Test doc', (await seal('hello world', key)) + '\n');
const D3 = '1ccccccccccccccccccccccccccccccccccccccccccc';
addDoc(D3, 'Plain doc', 'Just some plain text.\n');

// Every answer can be made slow, and the tests can wait until Google is quiet (an unlock saves in the background).
let slow = 0, inFlight = 0, lastAnswer = 0, writes = 0; // writes: batchUpdate calls, refused ones too
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settled = async () => { while (inFlight || Date.now() - lastAnswer < 150) await sleep(30); };
async function google(route) {
  inFlight++;
  try {
    if (slow && route.request().url().includes('docs.googleapis.com')) await sleep(slow);
    return await answer(route);
  } finally { inFlight--; lastAnswer = Date.now(); }
}
async function answer(route) {
  const req = route.request(), u = new URL(req.url()), json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (u.host === 'accounts.google.com') { // consent: straight back with a token
    const back = `${u.searchParams.get('redirect_uri')}#${new URLSearchParams({ access_token: 'tok', expires_in: '3600', scope: SCOPE, state: u.searchParams.get('state') })}`;
    return route.fulfill({ status: 302, headers: { location: back } });
  }
  if (fail401 > 0) { fail401--; return json(401, { error: { message: 'expired' } }); }
  if (u.host === 'openidconnect.googleapis.com') return json(200, { name: 'Test User', email: 'test@example.com' });
  if (u.pathname === '/drive/v3/files') {
    if (req.method() === 'GET') return json(200, { files: [] });
    const body = req.postDataJSON(), id = `1new${nextId++}`.padEnd(44, "x");
    if (body.mimeType.endsWith('document')) addDoc(id, body.name, '\n');
    return json(200, { id });
  }
  const m = u.pathname.match(/^\/v1\/documents\/([^/:]+)(:batchUpdate)?$/);
  const d = m && docs.get(m[1]);
  if (!d) return json(404, { error: { message: 'not found' } });
  if (!m[2]) return json(200, asDoc(m[1]));
  const body = req.postDataJSON();
  writes++;
  if (body.writeControl && body.writeControl.requiredRevisionId !== `r${d.rev}`) return json(400, { error: { message: 'The required revision ID does not match' } });
  for (const r of body.requests) {
    if (r.deleteContentRange) { const { startIndex: s, endIndex: e } = r.deleteContentRange.range; d.text = d.text.slice(0, s) + d.text.slice(e); }
    if (r.insertText) { const at = r.insertText.location.index; d.text = d.text.slice(0, at) + r.insertText.text + d.text.slice(at); }
  }
  d.versions.push(d.text);
  d.rev++;
  return json(200, { documentId: m[1], replies: [] });
}

// ---- the run
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.route(/accounts\.google\.com|googleapis\.com/, google);
const page = await ctx.newPage();
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text())); // the fake's 401 and 400s are on purpose
page.on('dialog', (d) => d.accept());

const $ = (id) => page.locator(`#${id}`);
const visibleStep = () => page.evaluate(() => document.querySelector('main > section:not([hidden])')?.id);
async function step(id) { await page.waitForFunction((s) => document.querySelector('main > section:not([hidden])')?.id === s && !document.querySelector('.leaving'), `step-${id}`, { timeout: 5000 }).catch(async () => assert.fail(`expected step-${id}, at ${await visibleStep()}; status: ${await $('status-text').textContent()}`)); if (id === 'editor') await settled(); }
async function status(re) { await page.waitForFunction((r) => new RegExp(r).test(document.getElementById('status-text').textContent), re.source, { timeout: 5000 }).catch(async () => assert.fail(`status ${re}, got "${await $('status-text').textContent()}"`)); }
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push(`ok   ${name}`); } catch (e) { checks.push(`FAIL ${name}: ${e.message.split("\n")[0]}`); }
  console.log(checks.at(-1));
  if (checks.at(-1).startsWith("FAIL")) throw new Error("stopped");
}

try {
  await check('first visit: welcome, sign in by redirect, on to the document step', async () => {
    await page.goto(url);
    await step('signin');
    assert.equal(await $('signin').textContent(), 'Sign in with Google');
    await $('signin').click();
    await step('doc');
  });
  await check('document step shows "create a new doc" (no recents yet)', async () => {
    assert.ok(await $('recents').isVisible(), '#recents hidden');
    assert.ok(await page.getByRole('link', { name: 'create a new doc' }).isVisible());
    assert.ok(!(await $('recents').textContent()).includes('pick a recent'));
  });
  await check('slides: forward right-to-left, back left-to-right', async () => {
    const anim = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).animationName, id);
    await page.getByRole('link', { name: 'create a new doc' }).click();
    assert.equal(await anim('step-doc'), 'step-out');
    await step('title');
    assert.equal(await anim('step-title'), 'step-in');
    await $('back-title').click();
    assert.equal(await anim('step-title'), 'step-out-back');
    await step('doc');
    assert.equal(await anim('step-doc'), 'step-in-back');
  });
  await check('bad link is refused', async () => {
    await $('link').fill('not a link');
    await $('doc-form').locator('button[type=submit]').click();
    await status(/./);
    await step('doc');
  });
  await check('doc without encrypted text: stays on the doc step, no password asked', async () => {
    await $('link').fill(`https://docs.google.com/document/d/${D3}/edit`);
    await $('doc-form').locator('button[type=submit]').click();
    await status(/No encrypted text/);
    await page.waitForTimeout(400);
    assert.equal(await visibleStep(), 'step-doc');
  });
  await check('open by link, wrong then right password, editor shows the text', async () => {
    await $('link').fill(`https://docs.google.com/document/d/${D1}/edit`);
    await $('doc-form').locator('button[type=submit]').click();
    await step('password');
    await page.waitForFunction(() => /Test doc/.test(document.getElementById('password-doc').textContent));
    await $('password').fill('wrong');
    await $('password-form').locator('button[type=submit]').click();
    await status(/^Wrong password, or the doc is damaged\.$/);
    assert.equal(await $('password-hint').isVisible(), false);
    await $('password-form').locator('button[type=submit]').click();
    await page.waitForSelector('#password-hint:not([hidden])'); // from the second wrong try, in any doc: The way back after a decoy unlock
    assert.match(await $('password-hint').textContent(), /Version history/);
    await step('password');
    await $('password').fill(PASS);
    await $('password-form').locator('button[type=submit]').click();
    await step('editor');
    await status(/^Unlocked/);
    assert.ok(await page.locator('#status.ok #status-icon use[href="#i-unlock"]').count(), 'green, with the open lock');
    assert.equal(await $('editor').inputValue(), 'hello world');
    assert.match(await $('doc-title').textContent(), /Test doc/);
  });
  await check('edit and save (button), the doc holds the new text; Save ↔ dimmed Saved', async () => {
    assert.ok(await $('save').isDisabled() && (await $('save').textContent()) === 'Saved', 'nothing to save yet');
    await $('editor').fill('hello world, edited');
    assert.ok(await $('save').isEnabled() && (await $('save').textContent()) === 'Save', 'changes to save');
    await $('save').click();
    await status(/^Saved at/);
    assert.equal(await docText(D1), 'hello world, edited');
    assert.ok(await $('save').isDisabled() && (await $('save').textContent()) === 'Saved', 'saved');
  });
  await check('save with Ctrl+S', async () => {
    await $('editor').fill('ctrl s text');
    await page.keyboard.press('Control+s');
    await status(/^Saved at/);
    assert.equal(await docText(D1), 'ctrl s text');
  });
  await check('formatting bar (with Undo), Ctrl+B, Edit / Preview; Lock clears the preview', async () => {
    const saved = await $('editor').inputValue();
    await $('editor').fill('note');
    await $('editor').evaluate((t) => t.setSelectionRange(0, 4));
    await page.click('[data-md="bold"]');
    assert.equal(await $('editor').inputValue(), '**note**');
    await page.keyboard.press('Control+z');
    assert.equal(await $('editor').inputValue(), 'note', 'undo restores the text');
    await page.click('[data-md="heading"]');
    await page.click('[data-md="bullets"]');
    assert.equal(await $('editor').inputValue(), '- note', 'a list replaces the heading');
    await $('editor').fill('# Title\nsome **bold** <b>x</b>\n- [ ] todo');
    await $('view-preview').click();
    assert.ok(await $('editor').isHidden() && await $('md-actions').isVisible() && await page.locator('[data-md="bold"]').isDisabled(), 'formatting dimmed in Preview');
    const html = await $('preview').innerHTML();
    assert.ok(/<h1[^>]*>Title<\/h1>/.test(html) && html.includes('<strong>bold</strong>') && html.includes('&lt;b&gt;x&lt;/b&gt;') && html.includes('type="checkbox"'), html);
    await $('preview').locator('li', { hasText: 'todo' }).dblclick(); // back to Markdown, at that line
    assert.ok(await $('editor').isVisible() && await $('preview').isHidden());
    assert.equal(await $('editor').evaluate((t) => t.selectionStart), '# Title\nsome **bold** <b>x</b>\n'.length, 'cursor at the double-clicked line');
    // Preview on and off keeps the place: The same line stays at the top
    await $('editor').fill(Array.from({ length: 200 }, (_, i) => (i % 10 ? `Line ${i}` : `## Part ${i}`)).join('\n'));
    await $('editor').evaluate((t) => { t.scrollTop = t.scrollHeight / 2; });
    const before = await $('editor').evaluate((t) => t.scrollTop);
    await $('view-preview').click();
    const atTop = await $('preview').evaluate((p) => [...p.querySelectorAll('[data-line]')].find((m) => m.getBoundingClientRect().bottom > p.getBoundingClientRect().top)?.dataset.line);
    assert.ok(Math.abs(Number(atTop) - 100) <= 3, `Preview opens near line 100, not ${atTop}`);
    await $('view-preview').click();
    assert.ok(Math.abs(await $('editor').evaluate((t) => t.scrollTop) - before) < 40, `back at the same place in the Markdown: ${before} vs ${await $('editor').evaluate((t) => t.scrollTop)}`);
    await $('editor').fill('x');
    await $('editor').evaluate((t) => t.setSelectionRange(0, 1));
    await page.keyboard.press('Control+b');
    assert.equal(await $('editor').inputValue(), '**x**');
    await $('editor').fill(saved); // as it was: Nothing to save
    assert.ok(await $('save').isDisabled());
  });
  await check('expired token mid-session: save signs in again in a popup', async () => {
    fail401 = 1;
    await $('editor').fill('after popup');
    await $('save').click(); // 401 → error, token forgotten
    await status(/expired/i);
    const popup = page.waitForEvent('popup');
    await $('save').click(); // popup sign-in, then save
    await popup;
    await status(/^Saved at/);
    assert.equal(await docText(D1), 'after popup');
  });
  await check('conflict: the doc changed elsewhere, both versions shown, keep mine', async () => {
    await editElsewhere(D1, 'their version');
    await $('editor').fill('my version');
    await $('save').click();
    await page.waitForSelector('#conflict:not([hidden])');
    assert.equal(await $('theirs').inputValue(), 'their version');
    await $('keep-mine').click();
    await status(/^Saved at/);
    assert.ok(await $('conflict').isHidden());
    assert.equal(await docText(D1), 'my version');
  });
  await check('conflict: use theirs', async () => {
    await editElsewhere(D1, 'theirs again');
    await $('editor').fill('mine again');
    await $('save').click();
    await page.waitForSelector('#conflict:not([hidden])');
    await $('use-theirs').click();
    assert.equal(await $('editor').inputValue(), 'theirs again');
    assert.ok(await $('conflict').isHidden());
    await status(/^Using their version\.$/);
    assert.match(await $('draft-text').textContent(), /Your version is kept as a draft/);
    await page.waitForTimeout(3300); // past the draft timer: Mine is still kept
    const kept = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('doclock'); r.onsuccess = () => { const q = r.result.transaction('drafts').objectStore('drafts').getAll(); q.onsuccess = () => res(q.result.length); }; }));
    assert.equal(kept, 1);
    await $('draft-restore').click(); // and Restore brings it back
    assert.equal(await $('editor').inputValue(), 'mine again');
    await $('save').click();
    await status(/^Saved at/);
  });
  await check('a text too long to save cannot be kept as a draft either: Lock asks first, and does not claim a draft', async () => {
    await page.evaluate(() => { const e = document.getElementById('editor'); e.value = Array.from({ length: 60000 }, () => Math.random().toString(36).slice(2, 10)).join(' '); e.dispatchEvent(new Event('input')); });
    await page.waitForFunction(() => /too long to save/.test(document.getElementById('doc-state').textContent));
    await $('save').click();
    await status(/too long for one doc/);
    const asked = [];
    const note = (d) => asked.push(d.message());
    page.on('dialog', note);
    await $('back-editor').click(); // the confirm is accepted
    await step('password');
    page.off('dialog', note);
    assert.match(asked.join(), /Lock without saving\? Your unsaved changes will be lost/);
    await status(/^Locked\.$/);
    await $('password').fill(PASS);
    await $('password-form').locator('button[type=submit]').click();
    await step('editor');
    assert.equal(await $('editor').inputValue(), 'mine again');
    assert.ok(await $('draft').isHidden());
  });
  await check('Discard drops the offered draft, not the edits made since: Lock keeps those', async () => {
    await $('editor').fill('mine again, first edit');
    await $('back-editor').click();
    await step('password');
    await status(/kept as a draft/);
    await $('password').fill(PASS);
    await $('password-form').locator('button[type=submit]').click();
    await step('editor');
    await page.waitForSelector('#draft:not([hidden])');
    await $('editor').fill('mine again, second edit');
    await page.waitForTimeout(3300); // the draft timer stores the second edit in the one slot
    await $('draft-discard').click();
    await $('back-editor').click();
    await step('password');
    await status(/kept as a draft/);
    await $('password').fill(PASS);
    await $('password-form').locator('button[type=submit]').click();
    await step('editor');
    await page.waitForSelector('#draft:not([hidden])');
    await $('draft-restore').click();
    assert.equal(await $('editor').inputValue(), 'mine again, second edit');
    await $('save').click();
    await status(/^Saved at/);
  });
  await check('reload picks up a change made elsewhere', async () => {
    await editElsewhere(D1, 'reloaded text');
    await $('reload').click(); // a confirm() if dirty: accepted
    await status(/Reloaded/);
    assert.equal(await $('editor').inputValue(), 'reloaded text');
  });
  await check('Lock slides the editor out to the right; the preview is emptied, Preview is remembered', async () => {
    await $('view-preview').click();
    await $('lock').click();
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('step-editor')).animationName), 'step-out-back');
    await step('signin');
    assert.equal(await $('preview').innerHTML(), '', 'no decrypted text left in the page');
    await $('signin').click();
    await step('doc');
    await page.getByRole('button', { name: 'Test doc' }).click();
    await $('password').fill(PASS);
    await $('password-form').locator('button[type=submit]').click();
    await step('editor');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('step-editor')).animationName), 'step-in');
    assert.ok(await $('preview').isVisible() && (await $('preview').innerHTML()).length > 0, 'opens in Preview, rendered');
    await $('view-preview').click(); // off
  });
  await check('Lock with unsaved edits → first screen, yellow "Locked", Continue signs in again', async () => {
    await $('editor').fill('unsaved draft text');
    await $('lock').click();
    await step('signin');
    await status(/^Locked\. Unsaved/);
    assert.match(await $('status').getAttribute('class'), /\bwarn\b/);
    assert.equal(await $('editor').inputValue(), '');
    assert.equal(await $('signin').textContent(), 'Continue');
    assert.equal(await $('who-name').textContent(), 'Test User');
    await $('signin').click(); // token was forgotten: redirect again
    await step('doc');
  });
  await check('the locked doc is in recents, with the create link', async () => {
    assert.ok(await $('recents').isVisible());
    assert.match(await $('recents').textContent(), /or create a new doc or pick a recent one/);
    assert.ok(await page.getByRole('button', { name: 'Test doc' }).isVisible());
  });
  await check('recent chip → password → draft offered and restored', async () => {
    await page.getByRole('button', { name: 'Test doc' }).click();
    await step('password');
    await $('password').fill(PASS);
    await $('password-form').locator('button[type=submit]').click();
    await step('editor');
    assert.equal(await $('editor').inputValue(), 'reloaded text');
    await page.waitForSelector('#draft:not([hidden])');
    await $('draft-restore').click();
    assert.equal(await $('editor').inputValue(), 'unsaved draft text');
    await $('save').click();
    await status(/^Saved at/);
    assert.equal(await docText(D1), 'unsaved draft text');
  });
  await check('← from the editor locks to the password step; ← again to the document step; ← to welcome', async () => {
    await $('back-editor').click();
    await step('password');
    assert.equal(await $('editor').inputValue(), '');
    await $('back-password').click();
    await step('doc');
    assert.ok(await $('recents').isVisible());
    await $('back-doc').click();
    await step('signin');
    await $('signin').click();
    await step('doc');
  });
  await check('remove a recent with ×', async () => {
    addDoc(D2, 'Other doc', (await seal('two', key)) + '\n');
    await $('link').fill(`https://docs.google.com/document/d/${D2}/edit`);
    await $('doc-form').locator('button[type=submit]').click();
    await step('password');
    await $('password').fill(PASS);
    await $('password-form').locator('button[type=submit]').click();
    await step('editor');
    await $('back-editor').click();
    await $('back-password').click();
    await step('doc');
    assert.equal(await $('recents').locator('.item').count(), 2);
    await $('link').fill(`https://docs.google.com/document/d/${D2}/edit?tab=t.0`); // the same doc, its first tab named
    await $('doc-form').locator('button[type=submit]').click();
    await step('password');
    await $('password').fill(PASS);
    await $('password-form').locator('button[type=submit]').click();
    await step('editor');
    await $('back-editor').click();
    await $('back-password').click();
    await step('doc');
    assert.equal(await $('recents').locator('.item').count(), 2, 'no duplicate for ?tab=t.0');
    await $('recents').locator('.item', { hasText: 'Other doc' }).locator('.forget').click();
    assert.equal(await $('recents').locator('.item').count(), 1);
  });
  await check('new doc: title (← back works), short passwords refused or warned, passwords must match, created in DocLock folder, editable', async () => {
    await page.getByRole('link', { name: 'create a new doc' }).click();
    await step('title');
    await $('back-title').click();
    await step('doc');
    await page.getByRole('link', { name: 'create a new doc' }).click();
    await step('title');
    await $('title').fill('My new notes');
    await $('title-form').locator('button[type=submit]').click();
    await step('newpass');
    await $('back-newpass').click();
    await step('title');
    await $('title-form').locator('button[type=submit]').click();
    await step('newpass');
    await $('newpass').fill('short');
    await $('newpass2').fill('short');
    await $('newpass-form').locator('button[type=submit]').click();
    await status(/at least 8/); // refused
    await $('newpass').fill('shortish1');
    await $('newpass2').fill('shortish1');
    await $('newpass-form').locator('button[type=submit]').click();
    await status(/under 12 characters/); // a warning only: Create again would use it
    assert.equal(await page.locator('#step-newpass').isVisible(), true);
    await $('newpass').fill(PASS);
    await $('newpass2').fill('different');
    await $('newpass-form').locator('button[type=submit]').click();
    await status(/don’t match/);
    await $('newpass2').fill(PASS);
    await $('newpass-form').locator('button[type=submit]').click();
    await step('editor');
    await status(/Created “My new notes”/);
    assert.equal(await $('editor').inputValue(), '');
    await $('editor').fill('first words');
    await $('save').click();
    await status(/^Saved at/);
    const id = [...docs.keys()].find((k) => docs.get(k).title === 'My new notes');
    assert.equal(await docText(id), 'first words');
    assert.ok(docs.get(id).text.includes(START));
  });

  // ---- decoy (docs/decoy.md): the editor's menu, the two passwords, what the doc shows
  const NEW = [...docs.keys()].find((k) => docs.get(k).title === 'My new notes'), DECOY = 'My first bike, was blue!', PASS2 = 'a brand new password';
  const menu = async (item) => { await $('more').click(); await $(`menu-${item}`).click(); await step(item); };
  const unlockWith = async (pass) => { await $('password').fill(pass); await $('password-form').locator('button[type=submit]').click(); await step('editor'); };
  await check('menu → Decoy…: needs its own password of 8+, then the doc opens with either password', async () => {
    const size = docs.get(NEW).text.length;
    await $('more').click();
    assert.equal(await $('menu').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await $('menu').isVisible(), false);
    await menu('decoy');
    assert.equal(await $('decoy-remove').isVisible(), false, 'nothing to remove yet');
    const submit = $('decoy-form').locator('button[type=submit]');
    await submit.click();
    await status(/Enter a decoy password/);
    await $('decoy-pass').fill('short');
    await submit.click();
    await status(/at least 8 characters for the decoy password/);
    await $('decoy-pass').fill(DECOY);
    await submit.click();
    await status(/decoy text is empty/); // a warning, once
    await $('decoy-text').fill('fake key 5Kb8');
    await $('decoy-pass').fill(PASS);
    await submit.click();
    await status(/its own password/);
    await step('decoy');
    await $('decoy-pass').fill(DECOY);
    await submit.click();
    await step('editor');
    await status(/^Decoy saved/);
    assert.equal(await $('editor').inputValue(), 'first words');
    assert.equal(await docText(NEW), 'first words');
    assert.equal(await docText(NEW, DECOY), 'fake key 5Kb8');
    assert.equal(docs.get(NEW).text.length, size, 'the doc is no longer than before');
  });
  await check('Decoy… shows it again: text edited, ← leaves it as it is', async () => {
    await menu('decoy');
    assert.equal(await $('decoy-pass').inputValue(), DECOY);
    assert.equal(await $('decoy-text').inputValue(), 'fake key 5Kb8');
    assert.equal(await $('decoy-remove').isVisible(), true);
    await $('decoy-text').fill('not kept');
    await $('back-decoy').click();
    await step('editor');
    assert.equal(await docText(NEW, DECOY), 'fake key 5Kb8');
    await menu('decoy');
    await $('decoy-text').fill('fake key 5Kb8, edited');
    await $('decoy-form').locator('button[type=submit]').click();
    await step('editor');
    await status(/^Decoy saved/);
    assert.equal(await docText(NEW, DECOY), 'fake key 5Kb8, edited');
    assert.equal(await docText(NEW), 'first words');
  });
  await check('a doc with a decoy keeps no local draft, and Lock asks before dropping edits', async () => {
    await $('editor').fill('first words, unsaved');
    await page.waitForTimeout(3300); // past the draft timer
    assert.equal(await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('doclock'); r.onsuccess = () => { const q = r.result.transaction('drafts').objectStore('drafts').getAll(); q.onsuccess = () => res(q.result.filter((d) => d.key.startsWith('1new')).length); }; })), 0);
    await $('editor').fill('first words');
  });
  await check('menu → Change password…: the old one stops working, the decoy still opens, the doc shows no sign', async () => {
    const line = () => docs.get(NEW).text.split('\n').find((l) => l.startsWith('v3.'));
    const before = line();
    await menu('pass');
    const submit = $('pass-form').locator('button[type=submit]');
    await $('pass-new').fill(PASS2);
    await $('pass-new2').fill('something else');
    await submit.click();
    await status(/don’t match/);
    await $('pass-new').fill(DECOY);
    await $('pass-new2').fill(DECOY);
    await submit.click();
    await status(/decoy’s password/);
    await $('pass-new').fill(PASS2);
    await $('pass-new2').fill(PASS2);
    await submit.click();
    await step('editor');
    await status(/^Password changed/);
    assert.equal(await docText(NEW, PASS2), 'first words');
    assert.equal(await docText(NEW, DECOY), 'fake key 5Kb8, edited');
    await assert.rejects(docText(NEW), /Wrong password/);
    assert.equal(line(), before, 'the same v3 line');
    await $('editor').fill('first words, after the change');
    await $('save').click();
    await status(/^Saved at/);
    assert.equal(await docText(NEW, PASS2), 'first words, after the change');
  });
  await check('every unlock saves the doc again: a new version, nothing of the old one left, the same text', async () => {
    await $('back-editor').click();
    await step('password');
    const d = docs.get(NEW), before = d.text, rev = d.rev;
    await unlockWith(PASS2);
    assert.equal(d.rev, rev + 1);
    assert.equal(d.text.length, before.length);
    assert.ok(body(d.text).every((l, i) => l !== body(before)[i]), 'both slots rewritten');
    assert.equal(await $('editor').inputValue(), 'first words, after the change');
    assert.equal(await docText(NEW, DECOY), 'fake key 5Kb8, edited', 'the decoy is carried along');
  });
  await check('a decoy changed with another tool: the save is refused, the doc opens read-only and is never written', async () => {
    const d = docs.get(NEW), good = d.text, block = readEncryptedDoc(asDoc(NEW), null).block.armoured;
    d.text = d.text.replace(block, await tamper(block, DECOY, 'fake key 5Kb8, edited by someone else'));
    d.rev++;
    const trap = d.text, rev = d.rev;
    assert.equal(await docText(NEW, DECOY), 'fake key 5Kb8, edited by someone else');
    assert.equal(await $('tampered').isVisible(), false);
    await $('editor').fill('typed while the trap was set');
    await $('save').click();
    await status(/Not saved: This doc was changed with another tool/);
    const readOnly = async () => [await $('tampered').isVisible(), await $('editor').evaluate((e) => e.readOnly), await $('save').isDisabled(), await $('more').isVisible()];
    assert.deepEqual(await readOnly(), [true, true, true, false]);
    await $('back-editor').click(); // asks before dropping the edit (accepted)
    await step('password');
    await unlockWith(PASS2);
    assert.equal(await $('editor').inputValue(), 'first words, after the change');
    assert.deepEqual(await readOnly(), [true, true, true, false]);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(300);
    assert.deepEqual([d.text === trap, d.rev], [true, rev], 'nothing written: To them, never opened');
    d.text = good; // the doc as it was (to them, a restore from the version history)
    d.rev++;
    await $('reload').click();
    await status(/^Reloaded/);
    assert.deepEqual(await readOnly(), [false, false, true, true]);
    assert.equal(await $('editor').inputValue(), 'first words, after the change');
  });
  await check('the unlock shows the text at once and saves in the background; a Save meanwhile waits and goes on top', async () => {
    await $('back-editor').click();
    await step('password');
    const d = docs.get(NEW), rev = d.rev, sent = writes;
    slow = 500;
    await $('password').fill(PASS2);
    await $('password-form').locator('button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('main > section:not([hidden])')?.id === 'step-editor');
    assert.equal(d.rev, rev, 'shown before the doc is written again');
    assert.equal(await $('editor').inputValue(), 'first words, after the change');
    await $('editor').fill('typed right after unlocking');
    await $('save').click();
    await status(/^Saved at/);
    slow = 0;
    assert.equal(d.rev, rev + 2, 'the unlock’s save, then mine');
    assert.equal(writes - sent, 2, 'mine waited: No write was refused and sent again');
    assert.equal(await docText(NEW, PASS2), 'typed right after unlocking');
    assert.equal(await docText(NEW, DECOY), 'fake key 5Kb8, edited');
    assert.equal(await $('conflict').isVisible(), false);
    await $('editor').fill('first words, after the change');
    await $('save').click();
    await status(/^Saved at/);
    await settled();
  });
  await check('the decoy password opens the decoy like any doc, and leaves only it; the earlier version has the text', async () => {
    await $('back-editor').click();
    await step('password');
    const d = docs.get(NEW), earlier = d.text;
    await unlockWith(DECOY);
    assert.equal(await $('editor').inputValue(), 'fake key 5Kb8, edited');
    await menu('decoy');
    assert.deepEqual([await $('decoy-pass').inputValue(), await $('decoy-text').inputValue(), await $('decoy-remove').isVisible()], ['', '', false], 'no sign of another text');
    await $('back-decoy').click();
    await step('editor');
    assert.equal(d.text.length, earlier.length);
    assert.equal(await docText(NEW, DECOY), 'fake key 5Kb8, edited');
    await assert.rejects(docText(NEW, PASS2), /Wrong password/);
    await $('editor').fill('edited under the decoy');
    await $('save').click();
    await status(/^Saved at/);
    assert.equal(await docText(NEW, DECOY), 'edited under the decoy');
    await $('back-editor').click();
    await step('password');
    // The real password opens nothing in the doc now, but it opens the version this browser kept: Offered (the confirm is accepted) and saved afresh.
    const wiped = d.text;
    await unlockWith(PASS2);
    await status(/earlier version is back/);
    assert.equal(await $('editor').inputValue(), 'first words, after the change');
    assert.equal(await docText(NEW, PASS2), 'first words, after the change');
    assert.equal(await docText(NEW, DECOY), 'fake key 5Kb8, edited', 'with the decoy as it was');
    assert.ok(body(d.text).every((l, i) => l !== body(earlier)[i] && l !== body(wiped)[i]), 'a fresh save, not a copy of an old version');
    assert.equal(await page.evaluate(() => location.hash), '#editor');
    await menu('decoy');
    assert.equal(await page.evaluate(() => location.hash), '#editor', 'the decoy screen leaves no mark in browser history');
    await $('back-decoy').click();
    await step('editor');
    await $('back-editor').click();
    await step('password');
    d.text = wiped; d.rev++; // as after the decoy unlock, in a browser that kept nothing…
    await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('doclock'); r.onsuccess = () => { const t = r.result.transaction('backups', 'readwrite'); t.objectStore('backups').clear(); t.oncomplete = res; }; }));
    await $('password').fill(PASS2);
    await $('password-form').locator('button[type=submit]').click();
    await status(/^Wrong password/);
    assert.equal(await $('password-hint').isVisible(), false);
    await $('password-form').locator('button[type=submit]').click();
    await page.waitForSelector('#password-hint:not([hidden])'); // the second wrong try, also after ← from the editor
    d.text = earlier; d.rev++; // …Google Docs: File → Version history → Restore this version
    await $('back-password').click();
    await step('doc');
    await $('link').fill(`https://docs.google.com/document/d/${NEW}/edit`);
    await $('doc-form').locator('button[type=submit]').click();
    await step('password');
    await unlockWith(PASS2);
    assert.equal(await $('editor').inputValue(), 'first words, after the change');
  });
  await check('Decoy… → Remove: its password opens nothing', async () => {
    await menu('decoy');
    await $('decoy-remove').click(); // the confirm is accepted
    await step('editor');
    await status(/^Decoy removed/);
    await assert.rejects(docText(NEW, DECOY), /Wrong password/);
    assert.equal(await docText(NEW, PASS2), 'first words, after the change');
  });
  await check('every version of the doc is the same size, with no line kept from the one before', async () => {
    const v = docs.get(NEW).versions.filter((t) => t.includes('v3.'));
    assert.ok(v.length >= 8, `${v.length} versions`);
    for (let i = 1; i < v.length; i++) {
      assert.equal(v[i].length, v[0].length, `version ${i}`);
      const [a, b] = [body(v[i - 1]), body(v[i])];
      assert.ok(a.length > 1300 && a.every((l, n) => l !== b[n]), `version ${i} rewrites both slots`);
    }
  });
  await check('a doc from before the decoy is rewritten in the new format by its first unlock', async () => {
    const OLD = '1ddddddddddddddddddddddddddddddddddddddddddd';
    addDoc(OLD, 'Old doc', '#####  DocLock encrypted text (AES-256-GCM, PBKDF2-SHA-256): https://github.com/antoniocosta/DocLock\nv2.600000.KfmnoVWvvd3GxIk0H7HXNg==.m/kHp/kFsZbXydjJ\nmlSE5gwoFj2zab7OER/0vLwxbVTDx2I3MXxmOBzV7MstJBHRlnI0fIVLZeA=\n#####  End encrypted text\n');
    await $('back-editor').click();
    await step('password');
    await $('back-password').click();
    await step('doc');
    await $('link').fill(`https://docs.google.com/document/d/${OLD}/edit`);
    await $('doc-form').locator('button[type=submit]').click();
    await step('password');
    await unlockWith('old password');
    assert.equal(await $('editor').inputValue(), 'written before the decoy ✓');
    assert.ok(docs.get(OLD).text.includes('\nv3.600000.KfmnoVWvvd3GxIk0H7HXNg==\n'), 'v3, the same salt');
    assert.equal(await docText(OLD, 'old password'), 'written before the decoy ✓');
    assert.equal(readEncryptedDoc(asDoc(OLD), null).block.armoured.length, readEncryptedDoc(asDoc(NEW), null).block.armoured.length, 'the same size as any doc');
  });
  await check('new doc with “Add a decoy”: both passwords open it from its first version', async () => {
    await $('back-editor').click();
    await step('password');
    await $('back-password').click();
    await step('doc');
    await page.getByRole('link', { name: 'create a new doc' }).click();
    await step('title');
    await $('title').fill('With a decoy');
    await $('title-form').locator('button[type=submit]').click();
    await step('newpass');
    assert.equal(await $('newdecoy').isVisible(), false);
    await $('add-decoy').click();
    await $('newdecoy').fill('changed my mind');
    await $('no-decoy').click(); // closes it again, and forgets what was typed
    assert.deepEqual([await $('newdecoy').isVisible(), await $('newdecoy').inputValue(), await $('add-decoy').isVisible()], [false, '', true]);
    await $('add-decoy').click();
    await $('newpass').fill(PASS);
    await $('newpass2').fill(PASS);
    await $('newdecoy').fill(PASS);
    await $('newpass-form').locator('button[type=submit]').click();
    await status(/its own password/);
    await $('newdecoy').fill(DECOY);
    await $('newpass-form').locator('button[type=submit]').click();
    await step('decoy'); // straight to the decoy, to write its text
    await status(/Created “With a decoy”.*Now write the decoy’s text/);
    assert.equal(await $('decoy-pass').inputValue(), DECOY);
    await $('back-decoy').click();
    await step('editor');
    const id = [...docs.keys()].find((k) => docs.get(k).title === 'With a decoy'), first = docs.get(id).versions[0];
    const openVersion = async (text, pass) => (await unlock(readEncryptedDoc({ ...asDoc(id), tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [{ endIndex: 1 }, { startIndex: 1, endIndex: text.length, paragraph: { elements: [{ startIndex: 1, endIndex: text.length, textRun: { content: text.slice(1) } }] } }] } } }] }, null).block.armoured, pass)).result;
    assert.deepEqual(await openVersion(first, DECOY), { text: '', decoy: null });
    assert.equal((await openVersion(first, PASS)).decoy.password, DECOY);
    await menu('decoy');
    assert.equal(await $('decoy-pass').inputValue(), DECOY);
    await $('back-decoy').click();
    await step('editor');
  });
  await check('password reveal toggles', async () => {
    await $('lock').click();
    await step('signin');
    await $('signin').click();
    await step('doc');
    await page.getByRole('button', { name: 'My new notes' }).click();
    await step('password');
    await $('password').fill('abc');
    await $('reveal').click();
    assert.equal(await $('password').getAttribute('type'), 'text');
    await $('reveal').click();
    assert.equal(await $('password').getAttribute('type'), 'password');
    await $('back-password').click();
    await step('doc');
  });
  await check('refresh in the editor → its password step, draft offered; browser Back = ←', async () => {
    await page.getByRole('button', { name: 'My new notes' }).click();
    await step('password');
    await $('password').fill(PASS2);
    await $('password-form').locator('button[type=submit]').click();
    await step('editor');
    await $('editor').fill('typed before refresh');
    await page.waitForTimeout(3500); // the draft timer
    await page.reload();
    await step('password');
    await $('password').fill(PASS2);
    await $('password-form').locator('button[type=submit]').click();
    await step('editor');
    await page.waitForSelector('#draft:not([hidden])');
    await page.goBack();
    await step('password');
    await page.goBack();
    await step('doc');
    await page.goBack();
    await step('signin');
    await $('signin').click();
    await step('doc');
  });
  await check('sign out wipes recents and the remembered account', async () => {
    await $('back-doc').click();
    await step('signin');
    await $('sign-out').click(); // confirm() accepted
    await status(/^Account forgotten\.$/);
    assert.equal(await $('signin').textContent(), 'Sign in with Google');
    assert.ok(await $('who').isHidden());
    const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('doclock')));
    assert.deepEqual(left, []);
    await $('signin').click();
    await step('doc');
    assert.equal(await $('recents').locator('.item').count(), 0);
  });
  await check("no page errors", async () => assert.deepEqual(errors, [], errors.join(" | ")));
} finally {
  await browser.close();
}

process.exitCode = checks.some((c) => c.startsWith('FAIL')) ? 1 : 0;
