// Receives Google's redirect (#access_token=…&state=…) and hands it to the
// DocLock app. Same origin only. The state says which kind of sign-in this
// is: "r." = redirect from the first screen, "p." = popup.
//  - Redirect: Keep the answer in sessionStorage and go back to the app,
//    which checks the state and picks it up at start-up. Never closes.
//  - Popup: Answer the page that opened the popup, then close the popup.
(function () {
  'use strict';
  var params = location.hash.slice(1) || location.search.slice(1);
  // Keep the token out of the address bar and history.
  history.replaceState(null, '', location.pathname);
  var state = new URLSearchParams(params).get('state') || '';
  var msg = document.getElementById('msg');

  if (state.indexOf('p.') !== 0) {
    try {
      sessionStorage.setItem('doclock.oauth.result', params);
    } catch (e) { /* the app reports that sign-in did not complete */ }
    location.replace('./');
    return;
  }

  var data = { type: 'doclock-oauth', state: state, params: params };
  try {
    var ch = new BroadcastChannel('doclock-oauth');
    ch.postMessage(data);
    ch.close();
  } catch (e) { /* very old browser */ }
  try {
    if (window.opener) window.opener.postMessage(data, location.origin);
  } catch (e) { /* opener gone */ }
  msg.textContent = 'Signed in. You can close this window.';
  setTimeout(function () { window.close(); }, 300);
})();
