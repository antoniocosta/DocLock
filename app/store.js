// What DocLock keeps in this browser. Never a password, key or plaintext.
//  localStorage: Recent docs (id, tab, title), the last account (name,
//    email, photo URL) for the welcome screen, Markdown or Preview, and the theme.
//  IndexedDB: Backups (the doc's ciphertext before and after each save, 20
//    per doc) and drafts (unsaved edits, encrypted with the doc's key).
//  sessionStorage (this tab only): Which doc is open, so a refresh returns
//    to its password step.

const RECENTS = 'doclock.recents.v1', USER = 'doclock.user.v1', VIEW = 'doclock.view.v1', THEME = 'doclock.theme.v1';
const local = {
  get: (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* a convenience only */ } },
};

/** The editor's last view on this device: 'edit' or 'preview'. */
export const getView = () => (local.get(VIEW, 'edit') === 'preview' ? 'preview' : 'edit');
export const setView = (v) => local.set(VIEW, v);

/** 'auto' (follow the device), 'light' or 'dark'; theme.js reads it before the page draws. */
export const getTheme = () => { const t = local.get(THEME, 'auto'); return ['light', 'dark'].includes(t) ? t : 'auto'; };
export const setTheme = (t) => local.set(THEME, t);

// The first tab ("t.0") is the doc itself, so a link with or without ?tab=t.0 is one recent; older lists may hold both.
const tabKey = (tabId) => (tabId && tabId !== 't.0' ? tabId : null);
const same = (r, docId, tabId) => r.docId === docId && tabKey(r.tabId) === tabKey(tabId);
export const getRecents = () => [].concat(local.get(RECENTS, []))
  .filter((r) => typeof r?.docId === 'string')
  .filter((r, i, all) => all.findIndex((x) => same(x, r.docId, r.tabId)) === i);
export const forgetRecent = (docId, tabId) => local.set(RECENTS, getRecents().filter((r) => !same(r, docId, tabId)));
export function rememberRecent({ docId, tabId, title }) {
  local.set(RECENTS, [{ docId, tabId: tabKey(tabId), title: String(title || '').slice(0, 200) }, ...getRecents().filter((r) => !same(r, docId, tabId))].slice(0, 8));
}

const OPEN = 'doclock.open.v1';
export const getOpen = () => { try { return JSON.parse(sessionStorage.getItem(OPEN)); } catch { return null; } };
export function setOpen(v) {
  try { if (v) sessionStorage.setItem(OPEN, JSON.stringify(v)); else sessionStorage.removeItem(OPEN); } catch { /* a convenience only */ }
}

export const getUser = () => { const u = local.get(USER, null); return u?.email ? u : null; };
export function rememberUser({ name, email, picture }) {
  if (email) local.set(USER, { name, email, picture: /^https:\/\/[\w.-]+\.googleusercontent\.com\//.test(picture) ? picture : '' });
}

// ---------------------------------------------------------------- IndexedDB

let db = null;
const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
function openDb() {
  if (!db) {
    const r = indexedDB.open('doclock', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('backups', { keyPath: 'id', autoIncrement: true }).createIndex('doc', 'docId');
      r.result.createObjectStore('drafts', { keyPath: 'key' });
    };
    db = request(r);
    db.catch(() => { db = null; });
  }
  return db;
}
/** Runs fn(store) in a transaction and resolves when it is committed. */
async function tx(name, mode, fn) {
  const t = (await openDb()).transaction(name, mode);
  const result = fn(t.objectStore(name));
  await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = t.onabort = () => reject(t.error); });
  return result instanceof IDBRequest ? result.result : result;
}

/** The ciphertexts kept for a doc, oldest first: [{ tabId, armoured, at, … }]. */
export const getBackups = (docId) => tx('backups', 'readonly', (s) => s.index('doc').getAll(docId));
/** Keeps a ciphertext of the doc, unless it is the newest one kept already; only the newest 20 per doc stay. */
export const addBackup = ({ docId, tabId, armoured, revisionId, title }) => tx('backups', 'readwrite', (s) => {
  s.index('doc').openCursor(docId, 'prev').onsuccess = (ev) => {
    if (ev.target.result?.value.armoured === armoured) return;
    s.add({ docId, tabId, armoured, revisionId, title, at: Date.now() });
    s.index('doc').getAllKeys(docId).onsuccess = (e) => e.target.result.slice(0, -20).forEach((k) => s.delete(k));
  };
});

const draftKey = (docId, tabId) => `${docId}|${tabId || ''}`;
export const putDraft = ({ docId, tabId, armoured }) => tx('drafts', 'readwrite', (s) => s.put({ key: draftKey(docId, tabId), armoured, at: Date.now() }));
export const getDraft = (docId, tabId) => tx('drafts', 'readonly', (s) => s.get(draftKey(docId, tabId)));
export const deleteDraft = (docId, tabId) => tx('drafts', 'readwrite', (s) => s.delete(draftKey(docId, tabId)));
export const countDrafts = () => tx('drafts', 'readonly', (s) => s.count()).catch(() => 0);

/** Removes everything DocLock keeps here: Recents, account, backups, drafts. */
export async function wipeAll() {
  for (const k of [RECENTS, USER, VIEW, THEME]) try { localStorage.removeItem(k); } catch { /* ignore */ }
  setOpen(null);
  if (db) (await db.catch(() => null))?.close();
  db = null;
  const r = indexedDB.deleteDatabase('doclock');
  r.onblocked = () => r.onerror?.();
  await request(r).catch(() => { throw new Error('Close other DocLock tabs, then try again.'); });
}
