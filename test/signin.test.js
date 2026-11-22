import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser globals for gdocs.js.
const mem = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};
const assigned = [];
globalThis.location = { origin: 'http://localhost:8080', pathname: '/', assign: (u) => assigned.push(u) };

const g = await import('../app/gdocs.js');
const SCOPES = encodeURIComponent('email profile https://www.googleapis.com/auth/documents openid');

beforeEach(() => { mem.clear(); assigned.length = 0; g.forgetToken(); });

function startRedirect(opts) {
  g.signInRedirect(opts);
  return new URL(assigned.at(-1));
}

test('signInRedirect goes to Google with the right parameters', () => {
  const url = startRedirect({ hint: 'someone@example.com' });
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = url.searchParams;
  assert.equal(p.get('response_type'), 'token');
  assert.equal(p.get('redirect_uri'), 'http://localhost:8080/oauth-callback.html');
  assert.equal(p.get('login_hint'), 'someone@example.com');
  assert.ok(p.get('scope').includes('https://www.googleapis.com/auth/documents'));
  assert.equal(p.get('state'), mem.get('doclock.oauth.state'));
});

test('a matching answer signs in; the token is kept in memory only', async () => {
  const state = startRedirect({}).searchParams.get('state');
  mem.set('doclock.oauth.result', `access_token=abc&token_type=Bearer&expires_in=3599&scope=${SCOPES}&state=${state}`);
  assert.deepEqual(g.finishRedirectSignIn(), { ok: true });
  assert.ok(g.hasToken());
  assert.equal(mem.has('doclock.oauth.result'), false, 'answer removed');
  assert.equal(mem.has('doclock.oauth.state'), false, 'state removed');
  assert.equal(g.finishRedirectSignIn(), null, 'only once');
});

test('an answer with another state is refused', () => {
  startRedirect({});
  mem.set('doclock.oauth.result', `access_token=evil&expires_in=3599&scope=${SCOPES}&state=forged`);
  const r = g.finishRedirectSignIn();
  assert.equal(r.ok, false);
  assert.equal(g.hasToken(), false);
});

test('an answer without a saved state is refused', () => {
  mem.set('doclock.oauth.result', `access_token=evil&expires_in=3599&scope=${SCOPES}&state=x`);
  assert.equal(g.finishRedirectSignIn().ok, false);
  assert.equal(g.hasToken(), false);
});

test('a refusal or a missing Docs permission is reported', () => {
  let state = startRedirect({}).searchParams.get('state');
  mem.set('doclock.oauth.result', `error=access_denied&state=${state}`);
  assert.equal(g.finishRedirectSignIn().error.code, 'denied');

  state = startRedirect({}).searchParams.get('state');
  mem.set('doclock.oauth.result', `access_token=abc&expires_in=3599&scope=email%20profile&state=${state}`);
  assert.equal(g.finishRedirectSignIn().error.code, 'scope');
  assert.equal(g.hasToken(), false);
});

test('signing out forgets the token, and asks Google nothing', () => {
  const state = startRedirect({}).searchParams.get('state');
  mem.set('doclock.oauth.result', `access_token=abc&expires_in=3599&scope=${SCOPES}&state=${state}`);
  g.finishRedirectSignIn();
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return {}; };
  g.signOut();
  assert.equal(fetched, false, 'Google consent is kept: nothing is revoked');
  assert.equal(g.hasToken(), false);
});
