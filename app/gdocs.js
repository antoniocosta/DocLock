// Google sign-in (OAuth 2.0 token flow, no Google script) and the Docs and
// Drive calls DocLock needs. Sign-in from the first screen is a full-page
// redirect; while a doc is open it is a popup, so the editor is never left.
// The token is kept in memory (after a redirect sign-in it passes through
// sessionStorage for the moment between the callback page and start-up):
// Gone on Lock, leaving the page or ~1 h.

const { CLIENT_ID = '' } = await import('./config.js').catch(() => ({}));
export const configured = /\.apps\.googleusercontent\.com$/.test(CLIENT_ID);

export const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
/** Files DocLock created (the DocLock folder, new docs): The narrowest Drive scope. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCOPES = `openid email profile ${DOCS_SCOPE} ${DRIVE_SCOPE}`;
const DOCS = 'https://docs.googleapis.com/v1/documents/';
const FILES = 'https://www.googleapis.com/drive/v3/files';

export class GoogleError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'GoogleError';
    this.code = code;
    this.status = status;
  }
}

let token = null; // { value, expiresAt, scopes }
let pending = null; // popup sign-in in progress

export const hasToken = () => !!token && Date.now() < token.expiresAt - 120e3;
export const hasScope = (scope) => hasToken() && token.scopes.includes(scope);
export const forgetToken = () => { token = null; };
export const signInPending = () => !!pending;

/** Signs out here; Google's consent is kept (it can be removed in the Google Account). */
export function signOut() {
  forgetToken();
  pending?.cancel();
}

function authUrl(state, { hint, chooseAccount } = {}) {
  // oauth-callback.html next to this page, wherever the app is served from.
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: new URL('oauth-callback.html', location.origin + location.pathname.replace(/[^/]*$/, '')).href,
    response_type: 'token',
    scope: SCOPES,
    state,
    include_granted_scopes: 'true',
  });
  if (hint) p.set('login_hint', hint);
  if (chooseAccount) p.set('prompt', 'select_account');
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/** Checks Google's answer (#access_token=…) and keeps the token. */
function accept(answer) {
  const p = new URLSearchParams(answer || ''), e = p.get('error');
  if (e) throw new GoogleError(e === 'access_denied' ? 'denied' : 'auth', e === 'access_denied' ? 'Sign-in cancelled, or access not allowed.' : `Google sign-in failed: ${e}`);
  const scopes = (p.get('scope') || '').split(' ');
  if (!p.get('access_token')) throw new GoogleError('auth', 'Google sign-in failed. Try again.');
  if (!scopes.includes(DOCS_SCOPE)) throw new GoogleError('scope', 'DocLock needs access to your Google Docs. Sign in again and allow it.');
  token = { value: p.get('access_token'), expiresAt: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000, scopes };
}

// The state's prefix tells oauth-callback.html which kind of sign-in it is.
const newState = (kind) => kind + Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('');
const STATE = 'doclock.oauth.state', RESULT = 'doclock.oauth.result';
const stash = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* reported at start-up */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

/** Sign-in by leaving the page for Google; it comes back via oauth-callback.html. */
export function signInRedirect(opts) {
  const state = newState('r.');
  stash.set(STATE, state);
  location.assign(authUrl(state, opts));
}

/** At start-up: Picks up a redirect sign-in. @returns {null | {ok: true} | {ok: false, error}} */
export function finishRedirectSignIn() {
  const answer = stash.get(RESULT), state = stash.get(STATE);
  stash.del(RESULT);
  stash.del(STATE);
  if (!answer) return null;
  try {
    if (!state || new URLSearchParams(answer).get('state') !== state) throw new GoogleError('auth', "Sign-in didn't match. Try again.");
    accept(answer);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Sign-in in a popup. Call straight from a click or key handler (before any
 * await) or the browser blocks it. Calling again abandons a waiting sign-in
 * (code 'superseded'), so a closed popup never leaves the app stuck.
 * onPopupClosed is only a hint: Google's pages cut the link to the popup.
 */
export function signIn({ onPopupClosed, ...opts } = {}) {
  pending?.cancel('superseded');
  const state = newState('p.');
  const popup = window.open(authUrl(state, opts), 'doclock-signin',
    `popup,width=500,height=650,left=${Math.max(0, (screen.width - 500) / 2)},top=${Math.max(0, (screen.height - 650) / 2)}`);
  if (!popup) return Promise.reject(new GoogleError('popup-blocked', 'Sign-in window blocked. Allow pop-ups for this site and try again.'));
  return new Promise((resolve, reject) => {
    // Google's pages cut window.opener, so the answer comes over a
    // same-origin BroadcastChannel as well as postMessage.
    const channel = new BroadcastChannel('doclock-oauth');
    const onMessage = (ev) => { if (ev.origin === location.origin) handle(ev.data); };
    const handle = (d) => {
      if (d?.type !== 'doclock-oauth' || d.state !== state) return;
      try { accept(d.params); finish(); } catch (e) { finish(e); }
    };
    let noticed = false;
    const watch = setInterval(() => { if (popup.closed && !noticed) { noticed = true; onPopupClosed?.(); } }, 500);
    const timer = setTimeout(() => finish(new GoogleError('timeout', 'Sign-in took too long. Try again.')), 300e3);
    const finish = (err, keepPopup) => {
      clearInterval(watch);
      clearTimeout(timer);
      channel.close();
      removeEventListener('message', onMessage);
      pending = null;
      if (!keepPopup) popup.close();
      if (err) reject(err); else resolve();
    };
    channel.onmessage = (ev) => handle(ev.data);
    addEventListener('message', onMessage);
    // A restarted sign-in reuses the same named window, so leave it open.
    pending = { cancel: (code = 'cancelled') => finish(new GoogleError(code, 'Sign-in cancelled.'), code === 'superseded') };
  });
}

async function call(url, { body, method = body ? 'POST' : 'GET' } = {}) {
  if (!hasToken()) throw new GoogleError('auth', 'Sign-in expired. Sign in again.');
  let res;
  try {
    res = await fetch(url, {
      method,
      body: body && JSON.stringify(body),
      headers: { Authorization: `Bearer ${token.value}`, ...(body && { 'Content-Type': 'application/json' }) },
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new GoogleError('network', "Can't reach Google. Check your connection.");
  }
  if (res.ok) return res.json();
  const { message = '', status = '' } = (await res.json().catch(() => ({}))).error || {};
  const detail = message ? ` (${message})` : '', why = message + status, err = (code, text) => new GoogleError(code, text, res.status);
  switch (res.status) {
    case 401:
      forgetToken();
      throw err('auth', 'Sign-in expired. Sign in again.');
    case 403:
      if (/has not been used|is disabled|SERVICE_DISABLED/i.test(why)) throw err('forbidden', `The ${url.startsWith(FILES) ? 'Google Drive' : 'Google Docs'} API is not enabled in this app's Google Cloud project.`);
      if (/insufficient.*scope|SCOPE_INSUFFICIENT/i.test(why)) { forgetToken(); throw err('scope', 'DocLock needs one more Google permission. Sign in again and allow it.'); }
      throw err('forbidden', `This Google account can't open this doc${detail}.`);
    case 404: throw err('not-found', 'Doc not found. Check the link and the Google account.');
    case 400: throw err(/revision/i.test(message) ? 'conflict' : 'bad-request', `Google refused the request${detail}.`);
    case 429: throw err('server', 'Google is busy. Wait a minute and try again.');
    default: throw err('server', `Google error ${res.status}${detail}. Try again.`);
  }
}

/**
 * documents.get with all tabs and inline suggestions (the only mode whose
 * indexes are valid for batchUpdate). Retries brief failures twice.
 */
export async function getDocument(docId) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call(`${DOCS}${encodeURIComponent(docId)}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE`);
    } catch (e) {
      if (attempt >= 2 || !(e.code === 'network' || (e.code === 'server' && e.status >= 429))) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/** documents.batchUpdate. Never retried automatically. */
export const batchUpdate = (docId, body) => call(`${DOCS}${encodeURIComponent(docId)}:batchUpdate`, { body });

/** Name, email and photo URL of the signed-in account. */
export async function getProfile() {
  const p = await call('https://openidconnect.googleapis.com/v1/userinfo');
  return { name: p.name || p.email || '', email: p.email || '', picture: p.picture || '' };
}

/** The "DocLock" folder at the top of My Drive, created if missing (drive.file sees only DocLock's own). */
export async function ensureFolder(name = 'DocLock') {
  const type = 'application/vnd.google-apps.folder';
  const q = `name = '${name.replace(/['\\]/g, '\\$&')}' and mimeType = '${type}' and 'root' in parents and trashed = false`;
  const found = await call(`${FILES}?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`);
  return found.files?.[0]?.id || (await call(`${FILES}?fields=id`, { body: { name, mimeType: type, parents: ['root'] } })).id;
}

/** A new, empty Google Doc in a folder. @returns {Promise<string>} its id */
export const createDocument = async (title, folderId) =>
  (await call(`${FILES}?fields=id`, { body: { name: title, mimeType: 'application/vnd.google-apps.document', parents: [folderId] } })).id;
