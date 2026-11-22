// DocLock UI, one step at a time: Sign in → document (or new: Title →
// password) → password → editor (and from its menu: Decoy, new password).

import { keyFor, seal, open, newKey, rekey, newDecoy, sameKey, fill } from './cipher.js';
import { parseDocLink, docLink, readEncryptedDoc } from './docmodel.js';
import * as google from './gdocs.js';
import * as store from './store.js';
import { saveText, openEarlier, SaveError } from './save.js';
import { startSetup, setupJustFinished, confetti } from './setup.js';
import { render } from './markdown.js';
import { actions } from './format.js';
import { ui, h, setStatus, explain, showError, go, current, whileBusy, isBusy, clearPasswords } from './ui.js';

let opened = null; // the chosen doc: { docId, tabId, info, wrong (passwords tried) }; ciphertext only
let session = null; // the unlocked doc: { docId, tabId, key, info, saved, decoy, savedDecoy, tampered, resaving }; never its password (a decoy's is in it)
let conflict = null; // the SaveError of a save that met another version: theirs (info), theirsText, theirsDecoy
let lastSaveError = null; // why the last save() returned false
let holdDrafts = false; // while a new decoy or key is being saved
let pendingDraft = null;
let lastDraftText = null;

/**
 * True once there is a Google sign-in. Call straight from a click or key
 * handler: It may open the sign-in popup. Shows errors itself.
 */
async function signedIn(scope = google.DOCS_SCOPE) {
  if (google.hasScope(scope)) return true;
  google.forgetToken();
  setStatus('Signing in… Finish in the Google window.');
  try {
    await google.signIn({ onPopupClosed: () => google.signInPending() && setStatus('Waiting for Google. Closed the window? Click again.', 'warn') });
    setStatus('');
    return true;
  } catch (e) {
    if (e.code !== 'superseded') showError(e);
    return false;
  }
}

// ---------------------------------------------------------------- welcome

// ?setup in the address previews the setup guide on a copy that is set up already (config.js is left alone).
const configured = google.configured && !new URLSearchParams(location.search).has('setup');

function renderWelcome() {
  ui['setup-note'].hidden = configured;
  if (!configured) { ui.who.hidden = ui['account-links'].hidden = true; ui.signin.textContent = 'Set up'; return; }
  const u = store.getUser();
  ui.who.hidden = !u;
  ui['account-links'].hidden = !u && !google.hasToken();
  ui.signin.textContent = u ? 'Continue' : 'Sign in with Google'; // name and photo show above it
  if (!u) return;
  ui['who-name'].textContent = u.name || u.email;
  ui['who-email'].textContent = u.name ? u.email : '';
  ui['who-pic'].hidden = !u.picture;
  if (u.picture) ui['who-pic'].src = u.picture;
}
ui['who-pic'].onerror = () => { ui['who-pic'].hidden = true; };

// ---------------------------------------------------------------- theme: Auto → Light → Dark

const THEMES = { auto: ['i-auto', 'Theme: Auto (follows your device)'], light: ['i-light', 'Theme: Light'], dark: ['i-dark', 'Theme: Dark'] };
const NEXT_THEME = { auto: 'light', light: 'dark', dark: 'auto' };
let theme = store.getTheme();
function applyTheme(t) {
  theme = t;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  ui.theme.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${THEMES[t][0]}"/></svg>`;
  ui.theme.title = `${THEMES[t][1]}. Click for ${NEXT_THEME[t]}.`;
  ui.theme.setAttribute('aria-label', ui.theme.title);
}
applyTheme(theme);
ui.theme.onclick = () => { store.setTheme(NEXT_THEME[theme]); applyTheme(NEXT_THEME[theme]); };

/** Signed in → on to the document step; otherwise leave the page for Google (no popup). */
function continueOrSignIn(opts) {
  if (!google.hasToken()) {
    setStatus('Signing in…');
    ui['step-signin'].querySelectorAll('button').forEach((b) => { b.disabled = true; });
    return google.signInRedirect(opts);
  }
  setStatus('');
  renderRecents();
  go('doc');
  google.getProfile().then((p) => { store.rememberUser(p); renderWelcome(); }, () => {}); // for the welcome screen next time
}

ui.signin.onclick = () => (configured ? continueOrSignIn({ hint: store.getUser()?.email }) : startSetup());
ui['other-account'].onclick = () => { google.forgetToken(); continueOrSignIn({ chooseAccount: true }); };
ui['sign-out'].onclick = async () => {
  const n = await store.countDrafts();
  if (!confirm('Forget this account in DocLock? This removes recent docs, local backups' +
    (n ? ` and ${n} unsaved draft${n > 1 ? 's' : ''}` : '') + ' from this browser. You stay signed in to Google, and your Google Docs stay as they are.')) return;
  google.signOut();
  opened = null;
  await whileBusy(ui['step-signin'], async () => {
    setStatus('Forgetting…');
    try {
      await store.wipeAll();
      view = 'edit';
      applyTheme('auto');
      setStatus('Account forgotten.', 'ok');
    } catch (e) {
      setStatus(`Account forgotten, but some local data couldn’t be removed: ${e.message}`, 'error');
    }
  });
  renderWelcome();
  ui.signin.focus();
};

// ---------------------------------------------------------------- document

function renderRecents() {
  const list = store.getRecents();
  const create = h('a', { href: '#', textContent: 'create a new doc', onclick: (ev) => { ev.preventDefault(); setStatus(''); go('title'); } });
  ui.recents.replaceChildren(h('li', { className: 'label' }, 'or ', create, list.length ? ' or pick a recent one' : ''),
    ...list.map((r) => h('li', { className: 'item' },
      h('button', { type: 'button', className: 'choice', textContent: r.title || r.docId, title: docLink(r.docId, r.tabId),
        onclick: () => { ui.link.value = docLink(r.docId, r.tabId); ui['doc-form'].requestSubmit(); } }),
      h('button', { type: 'button', className: 'forget', textContent: '×', title: 'Remove from recents',
        onclick: () => { store.forgetRecent(r.docId, r.tabId); renderRecents(); } }))));
}

ui['doc-form'].onsubmit = async (ev) => {
  ev.preventDefault();
  let target;
  try { target = parseDocLink(ui.link.value); } catch (e) { showError(e); ui.link.select(); return; }
  if (!(await signedIn())) return;
  // The doc is read first: No password is asked for a doc without encrypted text.
  const info = await whileBusy(ui['step-doc'], async () => {
    setStatus('Opening the doc…');
    try { return readEncryptedDoc(await google.getDocument(target.docId), target.tabId); } catch (e) { showError(e); }
  });
  if (!info) { store.setOpen(null); ui.link.select(); return; }
  opened = { ...target, info, wrong: 0 };
  store.setOpen({ docId: target.docId, tabId: target.tabId });
  ui['password-doc'].textContent = `The password for “${info.title || 'Untitled'}”${info.tabCount > 1 ? `, tab “${info.tabTitle}”` : ''}.`;
  clearPasswords();
  ui['password-hint'].hidden = true;
  setStatus('');
  go('password');
};
ui['back-doc'].onclick = () => { setStatus(''); renderWelcome(); go('signin'); };

// ---------------------------------------------------------------- password fields

ui['password-form'].onsubmit = async (ev) => {
  ev.preventDefault();
  const o = opened;
  if (!o || isBusy()) return;
  const password = ui.password.value;
  if (!password) return setStatus('Enter the password.', 'error');
  // The key takes a moment to work out (on purpose).
  const r = await whileBusy(ui['password-form'], async () => {
    setStatus('Unlocking…');
    let u;
    try {
      try { o.info = readEncryptedDoc(await google.getDocument(o.docId), o.tabId); } catch (e) { if (e.code !== 'network') throw e; } // the doc as it is now; offline: The copy read earlier
      const k = await keyFor(o.info.block.armoured, password);
      u = { k, result: await open(o.info.block.armoured, k).catch((e) => { if (e.code !== 'password') throw e; return null; }) };
      if (!u.result) Object.assign(u, await earlier(o, k)); // not this version: One kept in this browser?
    } catch (e) { return showError(e); }
    if (!u.result) {
      if ((o.wrong = (o.wrong || 0) + 1) > 1) ui['password-hint'].hidden = false; // the way back after a decoy unlock; said for every doc, so it shows nothing
      return setStatus('Wrong password, or the doc is damaged.', 'error');
    }
    if (u.restored) { // the earlier version must reach the doc before it is said to be back
      try { u.info = (await saveText({ session: { docId: o.docId, key: u.k, info: o.info }, text: u.result.text, decoy: u.result.decoy, google, store })).info; } catch (e) { return showError(e); }
    }
    return u;
  });
  if (!r) { if (opened === o) ui.password.select(); return; }
  setStatus(r.restored ? 'Unlocked. The earlier version is back.' : 'Unlocked.', 'ok', 'unlock');
  clearPasswords();
  store.rememberRecent({ docId: o.docId, tabId: o.info.linkTab, title: o.info.title });
  const shown = openEditor(o.docId, r.k, r.info || o.info, r.result), s = session; // the session is set before openEditor first waits
  if (!r.restored && !r.result.tampered) s.resaving = resave(s); // a doc changed with another tool is read, never written (readOnly)
  await shown;
};
/**
 * Every unlock saves the doc again, freshly encrypted: Saves that change no text are normal in every doc
 * (docs/decoy.md). In the background, so the text shows at once; Save and Reload wait for it (session.resaving).
 * Offline, view only…: The doc stays as it is. Never rejects.
 */
async function resave(s) {
  try {
    const { info } = await saveText({ session: { docId: s.docId, key: s.key, info: s.info }, text: s.saved, decoy: s.savedDecoy, google, store });
    if (session === s) { s.info = info; opened = { docId: s.docId, tabId: s.tabId, info }; }
  } catch (e) {
    if (e.code === 'tampered' && session === s) { readOnly(true); updateState(); } // changed with another tool right after this save: Read-only from here, Save dimmed
  }
}
/**
 * The password opens nothing in the doc as it is. Does its key open an earlier version kept in this browser
 * (store.addBackup: Every save, so every unlock, keeps the doc as it was and as it was saved)? Then offer to bring that back,
 * as after an unlock with a decoy password. Saved afresh, it looks like any other save.
 */
async function earlier(o, k) {
  const found = await openEarlier((await store.getBackups(o.docId).catch(() => [])).filter((b) => b.tabId === o.info.tabId), k);
  const yes = found && confirm(`This password opens an earlier version, kept in this browser on ${new Date(found.backup.at).toLocaleString()}.\n\nBring it back? The doc as it is now stays in Google Docs’ version history.`);
  return yes ? { result: found.result, restored: true } : {};
}
ui['back-password'].onclick = () => { opened = null; store.setOpen(null); clearPasswords(); setStatus(''); renderRecents(); go('doc'); };

// ---------------------------------------------------------------- new document

ui['back-title'].onclick = () => { setStatus(''); go('doc'); };
ui['title-form'].onsubmit = (ev) => {
  ev.preventDefault();
  if (!ui.title.value.trim()) return setStatus('Name the doc.', 'error');
  clearPasswords();
  setStatus('');
  go('newpass');
};
ui['back-newpass'].onclick = () => { clearPasswords(); setStatus(''); go('title'); };
/** A password typed twice: Enter in the first field moves to the second. */
const typedTwice = (first, second) => { first.onkeydown = (ev) => { if (ev.key === 'Enter' && first.value && !second.value) { ev.preventDefault(); second.focus(); } }; };
typedTwice(ui.newpass, ui.newpass2);
typedTwice(ui['pass-new'], ui['pass-new2']);

const warned = new WeakMap(); // fields whose short-password warning was shown for what is typed now
for (const id of ['newpass', 'newdecoy', 'decoy-pass', 'pass-new']) ui[id].addEventListener('input', () => warned.delete(ui[id]));
/** At least 8 characters; 8–11 get a warning, once per value (their choice). False = stop, the status says why. */
function longEnough(input, again, name = 'password') {
  const length = [...input.value].length;
  if (length < 8) { setStatus(`Use at least 8 characters for the ${name}.`, 'error'); input.focus(); return false; }
  if (length >= 12 || warned.get(input)) return true;
  warned.set(input, true);
  setStatus(`The ${name} is under 12 characters: Easy to guess. ${again} again to use it anyway.`, 'warn');
  return false;
}
/** Asked before any decoy password is set: What using it does. */
const decoyUnderstood = () => confirm('If you unlock with the decoy password, even just to test it, your real text is removed from the doc and your real password stops working.\n\nTo get it back, restore the earlier version in Google Docs (File → Version history).\n\nSet the decoy?');
ui['add-decoy'].onclick = () => { ui['newdecoy-offer'].hidden = true; ui['newdecoy-box'].hidden = false; ui.newdecoy.focus(); };
ui['no-decoy'].onclick = () => { ui.newdecoy.value = ''; warned.delete(ui.newdecoy); ui['newdecoy-box'].hidden = true; ui['newdecoy-offer'].hidden = false; ui['add-decoy'].focus(); };
ui['newpass-form'].onsubmit = async (ev) => {
  ev.preventDefault();
  if (isBusy()) return;
  const title = ui.title.value.trim();
  if (!ui.newpass.value) return setStatus('Enter a password.', 'error');
  if (ui.newpass.value !== ui.newpass2.value) { setStatus('Passwords don’t match.', 'error'); ui.newpass2.select(); return; }
  if (!longEnough(ui.newpass, 'Create')) return;
  const password = ui.newpass.value, decoyPassword = ui.newdecoy.value;
  if (decoyPassword.normalize('NFC') === password.normalize('NFC')) { setStatus('The decoy needs its own password.', 'error'); ui.newdecoy.select(); return; } // the key is made from the NFC form
  if (decoyPassword && !longEnough(ui.newdecoy, 'Create', 'decoy password')) return;
  if (!(await signedIn(google.DRIVE_SCOPE))) return; // creating needs the Drive permission; first, while the click still allows a popup
  if (decoyPassword && !decoyUnderstood()) return;
  let created = '', withDecoy = false;
  await whileBusy(ui['newpass-form'], async () => {
    let docId = null;
    try {
      setStatus('Creating the doc…');
      const key = await newKey(password);
      const decoy = decoyPassword ? await newDecoy(decoyPassword, '', key) : null; // in the doc from its first version
      docId = await google.createDocument(title, await google.ensureFolder());
      await google.batchUpdate(docId, { requests: [{ insertText: { location: { index: 1 }, text: await seal({ text: '', decoy }, key) + '\n' } }] });
      const info = readEncryptedDoc(await google.getDocument(docId), null);
      const result = await open(info.block.armoured, key);
      if (result.text) throw new Error('The new doc couldn’t be checked. Try again.');
      clearPasswords();
      ui.title.value = '';
      store.rememberRecent({ docId, tabId: null, title: info.title });
      await openEditor(docId, key, info, result);
      created = `Created “${info.title}” in your DocLock folder.`;
      setStatus(created, 'ok');
      withDecoy = !!decoy;
    } catch (e) {
      setStatus(explain(e) + (docId ? ` An empty doc “${title}” may be left in your DocLock folder.` : ''), 'error');
    }
  });
  if (withDecoy) { openDecoy(); setStatus(`${created} Now write the decoy’s text.`, 'ok'); } // its text is still empty
};

// ---------------------------------------------------------------- editor

const isDirty = () => !!session && ui.editor.value !== session.saved;
let full = '', fullTimer = null; // how full the doc is, once that is worth saying
const showCount = () => { ui['doc-state'].textContent = `${ui.editor.value.length.toLocaleString()} characters${full}`; }; // saved or not: The Save button says it
function updateState() {
  if (!session) return;
  const dirty = isDirty();
  showCount();
  clearTimeout(fullTimer);
  fullTimer = setTimeout(async () => { // a doc holds a fixed amount (cipher.js): Say so when it is nearly used
    const s = session, f = await fill({ text: ui.editor.value, decoy: s.decoy }).catch(() => 0);
    if (session !== s) return;
    full = f > 1 ? ' · too long to save' : f >= 0.8 ? ` · ${Math.floor(f * 100)}% full` : '';
    showCount();
  }, 400);
  if (view === 'preview') ui.preview.innerHTML = render(ui.editor.value, { lines: true }); // after a reload, a restored draft…
  // Save: Active "Save" with changes, dimmed "Saved" without; a short pop when it switches.
  if (!ui.save.closest('.frozen')) ui.save.disabled = !dirty || !!session.tampered; // a busy editor gets its state back from whileBusy; callers update after
  if (ui.save.classList.contains('saved') === dirty) {
    ui.save.classList.toggle('saved', !dirty);
    ui.save.textContent = dirty ? 'Save' : 'Saved';
    ui.save.classList.remove('pop');
    void ui.save.offsetWidth; // restart the animation
    ui.save.classList.add('pop');
  }
}
ui.editor.oninput = updateState;

// ---------------------------------------------------------------- Markdown: Formatting bar, Markdown / Preview

let view = store.getView(); // the last one on this device
/** Where each line of the text starts inside the editor (px), wrapping included: A hidden copy, measured. */
function editorLineTops() {
  const cs = getComputedStyle(ui.editor), copy = document.createElement('div');
  Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0', boxSizing: 'border-box',
    width: `${ui.editor.clientWidth}px`, padding: cs.padding, border: '0', font: cs.font, letterSpacing: cs.letterSpacing,
    tabSize: cs.tabSize, whiteSpace: 'pre-wrap', overflowWrap: cs.overflowWrap, wordBreak: cs.wordBreak });
  for (const line of ui.editor.value.split('\n')) copy.append(Object.assign(document.createElement('div'), { textContent: line || '\u200B' }));
  document.body.append(copy);
  const tops = [...copy.children].map((d) => d.offsetTop);
  copy.remove();
  return tops;
}
/** The line at the top of whichever view is showing, and how far into it (0–1). */
function topLine() {
  if (view === 'preview') {
    const top = ui.preview.getBoundingClientRect().top, marks = ui.preview.querySelectorAll('[data-line]');
    const el = [...marks].find((m) => m.getBoundingClientRect().bottom > top);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { line: Number(el.dataset.line), within: Math.min(1, Math.max(0, (top - r.top) / (r.height || 1))) };
  }
  const tops = editorLineTops(), y = ui.editor.scrollTop;
  let line = 0;
  while (line + 1 < tops.length && tops[line + 1] <= y) line++;
  const next = tops[line + 1] ?? ui.editor.scrollHeight;
  return { line, within: Math.min(1, Math.max(0, (y - tops[line]) / ((next - tops[line]) || 1))) };
}

function showView(next) {
  const place = view !== next && !ui.editor.hidden !== !ui.preview.hidden ? topLine() : null; // switching: Keep the reader's place
  view = next;
  store.setView(next);
  const preview = next === 'preview';
  ui.editor.hidden = preview;
  ui.preview.hidden = !preview;
  for (const b of ui['md-actions'].querySelectorAll('button')) b.disabled = preview; // dimmed: Formatting applies to the Markdown
  ui['view-preview'].setAttribute('aria-checked', preview);
  ui['view-preview'].title = preview ? 'Back to the Markdown text' : 'Show the text formatted';
  ui.preview.innerHTML = preview ? render(ui.editor.value, { lines: true }) : ''; // render() escapes everything (markdown.js)
  if (!place) return;
  if (preview) { // the last block starting at or before that line
    let el = null;
    for (const m of ui.preview.querySelectorAll('[data-line]')) if (Number(m.dataset.line) <= place.line) el = m;
    if (el) ui.preview.scrollTop += el.getBoundingClientRect().top - ui.preview.getBoundingClientRect().top + el.getBoundingClientRect().height * (Number(el.dataset.line) === place.line ? place.within : 0);
    else ui.preview.scrollTop = 0;
  } else {
    const tops = editorLineTops(), at = tops[Math.min(place.line, tops.length - 1)] ?? 0;
    const next = tops[place.line + 1] ?? ui.editor.scrollHeight;
    ui.editor.scrollTop = at + (next - at) * place.within;
  }
}
// Double-click in Preview: Back to the Markdown, the cursor at the start of that line.
ui.preview.ondblclick = (ev) => {
  const el = ev.target.closest('[data-line]');
  if (!el || !session) return;
  const line = Number(el.dataset.line), text = ui.editor.value;
  let pos = 0;
  for (let n = 0; n < line && pos >= 0; n++) pos = text.indexOf('\n', pos) + 1 || -1;
  showView('edit');
  const lineHeight = parseFloat(getComputedStyle(ui.editor).lineHeight) || 27; // that line about a third down, roughly…
  ui.editor.scrollTop = Math.max(0, line * lineHeight - ui.editor.clientHeight / 3);
  ui.editor.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
  ui.editor.focus(); // …and the browser scrolls the cursor into view if wrapped lines put it elsewhere
};
ui.preview.title = 'Double-click to edit here';
ui['view-preview'].onclick = () => {
  showView(view === 'preview' ? 'edit' : 'preview');
  if (view === 'edit') ui.editor.focus({ preventScroll: true }); // the place kept, not the cursor's
};
ui['md-actions'].onclick = (ev) => {
  const b = ev.target.closest('[data-md]');
  if (b && session && !session.tampered) actions[b.dataset.md](ui.editor);
};
ui.editor.onkeydown = (ev) => { // Ctrl/⌘+B bold, Ctrl/⌘+I italic
  if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey || session?.tampered) return;
  const k = ev.key.toLowerCase();
  if (k === 'b' || k === 'i') { ev.preventDefault(); actions[k === 'b' ? 'bold' : 'italic'](ui.editor); }
};

const NOT_SAVED = 'Not saved: This doc was changed with another tool.';
/**
 * A doc whose decoy was changed with another tool (cipher.js: tampered) is read, never written: A save would
 * put the decoy back as it was, and that shows whoever changed it a second password (docs/decoy.md).
 */
function readOnly(on) {
  if (session) session.tampered = on;
  ui.tampered.hidden = !on;
  ui.editor.readOnly = ui.more.hidden = on;
  if (on) closeMenu();
  if (on && (current === 'decoy' || current === 'pass') && !isBusy()) backToEditor(); // the menu's screens are closed too: The editor says why
}
async function openEditor(docId, key, info, result) {
  opened = { docId, tabId: info.tabId, info };
  store.setOpen({ docId, tabId: info.tabId });
  session = { docId, tabId: info.tabId, key, info, saved: result.text, decoy: result.decoy, savedDecoy: result.decoy };
  readOnly(!!result.tampered);
  full = '';
  lastDraftText = ui.editor.value = result.text;
  ui.conflict.hidden = ui.draft.hidden = true;
  ui['doc-title'].textContent = info.title || 'Untitled doc';
  ui['doc-title'].href = docLink(docId, info.tabId);
  showView(view);
  updateState();
  go('editor');
  ui.editor.setSelectionRange(0, 0);
  ui.editor.scrollTop = 0;
  try { // an unsaved draft from earlier?
    if (session.decoy) return await store.deleteDraft(docId, info.tabId); // none is kept beside a decoy (saveDraft)
    const d = await store.getDraft(docId, info.tabId);
    if (!d || session?.key !== key) return;
    const text = (await open(d.armoured, key)).text;
    if (text === session.saved) return store.deleteDraft(docId, info.tabId);
    pendingDraft = text;
    ui['draft-text'].textContent = `Unsaved changes from ${new Date(d.at).toLocaleString()} found in this browser.`;
    ui.draft.hidden = false;
  } catch { /* none, another password, or no storage */ }
}

ui['draft-restore'].onclick = () => {
  ui.editor.value = pendingDraft;
  ui.draft.hidden = true;
  updateState();
  setStatus('Draft restored. Save to keep it.', 'ok');
};
ui['draft-discard'].onclick = () => { // the offered draft goes; edits made since are stored in its place (the one slot may hold them already)
  ui.draft.hidden = true;
  lastDraftText = null;
  saveDraft();
};

/**
 * Keeps unsaved edits in IndexedDB, encrypted with the doc's key. Takes the text and key before its first await.
 * A doc with a decoy keeps none: A draft that only the real password opens would give the decoy away.
 * @returns {Promise<boolean>} a draft of the editor's text is now kept. False also when there is nothing
 *   to keep, the text is too long to encrypt, or the browser has no storage: Then only a warning protects it.
 */
async function saveDraft() {
  const s = session, text = ui.editor.value;
  if (!s || holdDrafts) return false;
  const keep = text !== s.saved && !s.decoy;
  if (text === lastDraftText) return keep; // done for this text already
  try {
    await (keep ? store.putDraft({ docId: s.docId, tabId: s.tabId, armoured: await seal(text, s.key) }) : store.deleteDraft(s.docId, s.tabId));
    lastDraftText = text;
    return keep;
  } catch { return false; }
}
/** Before the editor's unsaved text is dropped. @returns {Promise<{go: boolean, kept: boolean}>} go: Carry on (a draft is kept, or the user agrees to lose the text); kept: A draft is kept. */
async function draftOrAgree(question) {
  const s = session;
  if (!isDirty()) return { go: true, kept: false };
  const kept = await saveDraft();
  return { go: session === s && (kept || confirm(`${question} Your unsaved changes will be lost.`)), kept };
}
setInterval(saveDraft, 3000);

/**
 * Saves the editor's text, and the session's decoy and key as they are now.
 * @param {HTMLElement} [from] the screen asking, when it is not the editor: Saves without edits too
 * @param {object} [readKey] the key the doc is under now, when the session's key is a new one (saveText)
 * @returns {Promise<boolean>} saved
 */
async function save(from, readKey) {
  const s = session;
  lastSaveError = null;
  if (!s || s.tampered || isBusy() || !(from || isDirty()) || !(await signedIn()) || session !== s) return false; // locked while Google's window was open
  const text = ui.editor.value, decoy = s.decoy;
  let ok = false;
  await whileBusy(from || ui['step-editor'], async () => {
    try {
      setStatus('Saving…');
      await s.resaving; // the unlock's own save first: This one goes on top of it
      if (session !== s) return;
      if (s.tampered) return setStatus(NOT_SAVED, 'error'); // found by the unlock's save
      const r = await saveText({ session: s, text, decoy, base: { text: s.saved, decoy: s.savedDecoy }, readKey: readKey || s.key, google, store, onStep: (m) => setStatus(m) });
      Object.assign(s, { info: r.info, saved: text, savedDecoy: decoy });
      opened = { docId: s.docId, tabId: s.tabId, info: r.info };
      ui.conflict.hidden = true;
      await store.deleteDraft(s.docId, s.tabId).then(() => { lastDraftText = text; }, () => {});
      ok = true;
      setStatus(`Saved at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` +
        (r.backupFailed ? ' Local backup failed; Google’s version history has the old text.' : ''), r.backupFailed ? 'warn' : 'ok');
    } catch (e) {
      lastSaveError = e;
      if (e instanceof SaveError && e.code === 'conflict') {
        conflict = e;
        ui.theirs.value = e.theirsText ?? `(Can’t decrypt their version with your password: ${explain(e.theirsError)})`;
        ui['use-theirs'].hidden = e.theirsText == null;
        ui.conflict.hidden = false;
        saveDraft();
      }
      if (e.code === 'tampered' && session === s) readOnly(true); // changed with another tool while it was open here
      // a conflict or an unchecked save needs a look, but nothing is lost
      showError(e, ['conflict', 'verify-after'].includes(e.code) ? 'warn' : 'error');
    }
  });
  updateState();
  return ok;
}
ui.save.onclick = () => save();

ui['keep-mine'].onclick = () => { // back up theirs, write my text on their revision
  if (!session || !conflict) return;
  session.info = conflict.theirs;
  if (conflict.theirsText != null) session.decoy = session.savedDecoy = conflict.theirsDecoy; // a decoy is saved the moment it is set: Theirs is the newer one
  save(ui['step-editor']); // also when the editor has no edits (the conflict came from the decoy or password screen)
};
ui['use-theirs'].onclick = async () => {
  const s = session, c = conflict;
  if (!s || !c) return;
  const mine = ui.editor.value;
  // Mine stays as a local draft when one can be kept. Not beside their decoy (saveDraft removes it): Then ask.
  const { go, kept } = c.theirsDecoy ? { go: !isDirty() || confirm('Use their version? Your unsaved changes will be lost.'), kept: false } : await draftOrAgree('Use their version?');
  if (!go) return;
  Object.assign(s, { info: c.theirs, saved: c.theirsText, decoy: c.theirsDecoy, savedDecoy: c.theirsDecoy });
  ui.editor.value = c.theirsText;
  lastDraftText = null; // the stored draft is not this text
  ui.conflict.hidden = true;
  if (kept) { // as after a crash: Restore brings mine back
    pendingDraft = mine;
    lastDraftText = c.theirsText; // leave the stored draft be until this text is edited
    ui['draft-text'].textContent = 'Your version is kept as a draft.';
    ui.draft.hidden = false;
  }
  updateState();
  setStatus('Using their version.', 'ok');
};

ui.reload.onclick = async () => {
  const s = session;
  if (!s || isBusy()) return;
  if (!(await signedIn()) || session !== s) return;
  if (!(await draftOrAgree('Reload the doc?')).go) return; // unsaved changes: Kept as a draft and offered back, or given up
  await whileBusy(ui['step-editor'], async () => {
    setStatus('Reloading…');
    try {
      await s.resaving; // the unlock's own save first
      if (session !== s) return;
      const info = readEncryptedDoc(await google.getDocument(s.docId), s.tabId);
      await openEditor(s.docId, s.key, info, await open(info.block.armoured, s.key));
      setStatus('Reloaded.', 'ok');
    } catch (e) { showError(e); }
  });
  updateState();
};

// ---------------------------------------------------------------- the editor's menu: Decoy, new password

const closeMenu = () => { ui.menu.hidden = true; ui.more.setAttribute('aria-expanded', 'false'); };
ui.more.onclick = (ev) => {
  ev.stopPropagation();
  ui.menu.hidden = !ui.menu.hidden;
  ui.more.setAttribute('aria-expanded', !ui.menu.hidden);
  if (!ui.menu.hidden) ui['menu-pass'].focus();
};
addEventListener('click', closeMenu);
addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !ui.menu.hidden) { closeMenu(); ui.more.focus(); } });
const backToEditor = () => { clearPasswords(); setStatus(''); go('editor'); };
ui['back-pass'].onclick = backToEditor;
ui['back-decoy'].onclick = () => {
  const changed = session && (ui['decoy-pass'].value !== (session.decoy?.password ?? '') || ui['decoy-text'].value !== (session.decoy?.text ?? ''));
  if (!changed || confirm('Leave without saving the decoy?')) backToEditor();
};

let emptyWarned = false; // the empty-text warning was shown on this visit to the decoy screen
function openDecoy() {
  if (!session || session.tampered || isBusy()) return;
  clearPasswords();
  ui['decoy-pass'].value = session.decoy?.password ?? '';
  ui['decoy-text'].value = session.decoy?.text ?? '';
  ui['decoy-remove'].hidden = !session.decoy;
  emptyWarned = false;
  setStatus('');
  go('decoy');
}
ui['menu-decoy'].onclick = openDecoy;
/**
 * Saves the doc with a new decoy (null: None) or a new key. If nothing was written the old one stays;
 * a conflict is shown in the editor, where both versions are.
 * @param {'decoy'|'key'} field @param {string} done the status when saved
 */
async function saveChange(from, field, value, done) {
  const s = session, before = s[field];
  if (!(await signedIn()) || session !== s) return; // before anything changes: A sign-in left unfinished must leave the session as it was
  s[field] = value;
  holdDrafts = true; // no draft under a key or beside a decoy that the doc may not get
  try {
    if (await save(from, field === 'key' ? before : undefined)) { backToEditor(); return setStatus(done, 'ok'); } // the doc is still under the old key
    if (session !== s) return;
    if (lastSaveError?.code === 'verify-after') { if (field === 'decoy') s.savedDecoy = value; return; } // written, but unchecked: Keep it
    s[field] = before;
    lastDraftText = null; // a draft may have been made meanwhile: Make it again
    if (lastSaveError?.code === 'conflict') { // the two versions are in the editor; the change itself was not made
      clearPasswords();
      go('editor');
      setStatus(`${field === 'key' ? 'Password not changed' : 'Decoy not saved'}: The doc was changed elsewhere. Choose a version, then try again.`, 'warn');
    } else if (s.tampered) { clearPasswords(); go('editor'); setStatus(NOT_SAVED, 'error'); } // the editor says why
  } finally { holdDrafts = false; }
}
const setDecoy = (decoy, done) => saveChange(ui['step-decoy'], 'decoy', decoy, done);
ui['decoy-form'].onsubmit = async (ev) => {
  ev.preventDefault();
  const s = session, password = ui['decoy-pass'].value, text = ui['decoy-text'].value;
  if (!s || s.tampered || isBusy()) return;
  if (!password) { setStatus('Enter a decoy password.', 'error'); ui['decoy-pass'].focus(); return; }
  const fresh = password !== s.decoy?.password, done = 'Decoy saved. To check it, come back here: ⋮ → Decoy…';
  if (fresh && !longEnough(ui['decoy-pass'], 'Save', 'decoy password')) return;
  if (!text.trim() && !emptyWarned) { // an empty doc convinces nobody
    emptyWarned = true;
    setStatus('The decoy text is empty. Save again to keep it empty.', 'warn');
    ui['decoy-text'].focus();
    return;
  }
  if (!fresh) return text === s.decoy.text ? backToEditor() : setDecoy({ ...s.decoy, text }, done);
  if (!(await signedIn()) || session !== s || !decoyUnderstood()) return; // sign-in first, while the click still allows a popup
  const decoy = await whileBusy(ui['step-decoy'], async () => {
    setStatus('Saving…');
    try {
      const d = await newDecoy(password, text, s.key);
      if (!(await sameKey(d, s.key))) return d; // the doc's own password is not kept, so the keys are compared
      setStatus('The decoy needs its own password.', 'error');
    } catch (e) { showError(e); }
  });
  if (decoy && session === s) await setDecoy(decoy, done);
  else ui['decoy-pass'].select();
};
ui['decoy-remove'].onclick = () => {
  if (session?.decoy && !session.tampered && !isBusy() && confirm('Remove the decoy? Its password will no longer open this doc.')) setDecoy(null, 'Decoy removed.');
};

ui['menu-pass'].onclick = () => { if (session && !session.tampered && !isBusy()) { clearPasswords(); setStatus(''); go('pass'); } };
ui['pass-form'].onsubmit = async (ev) => {
  ev.preventDefault();
  const s = session, password = ui['pass-new'].value;
  if (!s || s.tampered || isBusy()) return;
  if (!password) return setStatus('Enter a password.', 'error');
  if (password !== ui['pass-new2'].value) { setStatus('Passwords don’t match.', 'error'); ui['pass-new2'].select(); return; }
  if (password.normalize('NFC') === s.decoy?.password.normalize('NFC')) { setStatus('That is the decoy’s password. Choose another.', 'error'); ui['pass-new'].select(); return; }
  if (!longEnough(ui['pass-new'], 'Change') || !(await signedIn()) || session !== s) return; // sign-in first, while the click still allows a popup
  const key = await whileBusy(ui['step-pass'], async () => {
    setStatus('Saving…');
    try { return await rekey(password, s.key); } catch (e) { showError(e); } // the same salt: The doc shows no sign of the change
  });
  if (key && session === s) await saveChange(ui['step-pass'], 'key', key, 'Password changed.');
};

/** Drops the plaintext and key from the page (and the passwords typed). */
function forget() {
  session = pendingDraft = conflict = lastSaveError = lastDraftText = null;
  readOnly(false);
  clearTimeout(fullTimer);
  ui.editor.value = ui.theirs.value = '';
  ui.preview.textContent = '';
  clearPasswords();
}

/** Lock: Unsaved edits to an encrypted draft, then forget. To the first screen (dropping the Google token), or ← to the password. */
async function lock(to = 'signin') {
  if (!session || isBusy()) return;
  const { go: agreed, kept } = await draftOrAgree('Lock without saving?'); // no draft with a decoy, a text too long, or no storage
  if (!agreed || !session) return; // …or locked twice
  opened = { docId: session.docId, tabId: session.tabId, info: session.info };
  forget();
  if (to === 'signin') { google.forgetToken(); store.setOpen(null); renderWelcome(); }
  go(to);
  setStatus('Locked.' + (kept ? ' Unsaved changes are kept as a draft.' : ''), 'warn', 'lock');
}
ui.lock.onclick = () => lock();
ui['back-editor'].onclick = () => lock('password');

// Everything lasts while the page is open. Leaving it ends it, even if the
// browser keeps the page frozen for Back: A draft is saved, then all is
// forgotten; a page brought back reloads.
addEventListener('pagehide', () => { saveDraft(); forget(); opened = null; google.forgetToken(); });
addEventListener('pageshow', (ev) => ev.persisted && location.reload());
addEventListener('beforeunload', (ev) => { if (isDirty()) { saveDraft(); ev.preventDefault(); ev.returnValue = ''; } });

addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); if (current === 'editor') save(); }
  // Enter on the welcome screen = the main button (a key press allows the redirect/popup)
  else if (ev.key === 'Enter' && current === 'signin' && !ev.repeat && document.activeElement?.tagName !== 'BUTTON') { ev.preventDefault(); ui.signin.click(); }
});

// ---------------------------------------------------------------- start

// The browser's Back does what the ← on screen does: One spare history
// entry catches it. On the first screen it leaves.
if (!history.state?.trap) history.pushState({ trap: true }, '');
addEventListener('popstate', () => {
  const arrow = ui[`back-${current}`];
  if (!arrow) return history.back();
  history.pushState({ trap: true }, '');
  if (!isBusy()) arrow.click();
});

navigator.serviceWorker?.register('sw.js').catch(() => {}); // installable, starts offline (sw.js)
let tooOld = false; // the text is deflated before it is encrypted (cipher.js): Chrome 103, Firefox 113, Safari 16.4
try { new CompressionStream('deflate-raw'); } catch { tooOld = true; }
const startHash = location.hash.slice(1); // before go() replaces it
renderWelcome();
const back = google.finishRedirectSignIn(), resume = store.getOpen();
if (back?.ok) {
  continueOrSignIn();
  if (resume) { ui.link.value = docLink(resume.docId, resume.tabId); ui['doc-form'].requestSubmit(); } // after a refresh
} else if (resume && !back && !resume.tried && configured) {
  // Refreshed with a doc open: Sign in again (usually just a redirect), then its password step.
  store.setOpen({ ...resume, tried: true }); // once: Coming Back from Google lands on the first screen
  go('signin');
  continueOrSignIn({ hint: store.getUser()?.email });
} else {
  store.setOpen(null);
  go('signin');
  if (back) showError(back.error);
  else if (setupJustFinished()) { setStatus('You’re all set! Sign in to start.', 'ok'); confetti(); }
  else if (!configured && /^(setup)?[1-9]$/.test(startHash)) startSetup(startHash); // ?setup#7 opens step 7
  else if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) setStatus(`Google sign-in needs https or http://localhost. This page is at ${location.origin}.`, 'error');
}
if (tooOld) setStatus('This browser is too old for DocLock. Update it.', 'error');
