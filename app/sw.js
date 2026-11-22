// DocLock's service worker: Makes the app installable and lets it start
// without a connection. Network first, always: the newest files are used
// whenever the server can be reached, and the cached copy only when it
// cannot. Only the app's own files are cached; requests to Google (and so
// any doc text) never pass through here.

const CACHE = 'doclock-app';
const FILES = [
  './', 'index.html', 'style.css', 'theme.js', 'app.js', 'ui.js', 'store.js', 'gdocs.js', 'save.js', 'docmodel.js',
  'cipher.js', 'setup.js', 'markdown.js', 'format.js', 'config.js', 'oauth-callback.html', 'oauth-callback.js',
  'logo.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  // One missing file (config.js on a fresh copy) must not stop the rest.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(FILES.map((f) => c.add(f).catch(() => {})))));
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      // Keep a fresh copy, without the query or hash (the sign-in callback has a token in its hash, never cached).
      if (res.ok && !url.search) (await caches.open(CACHE)).put(url.pathname, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(url.pathname, { ignoreSearch: true })
        || (req.mode === 'navigate' && await caches.match('./'));
      if (hit) return hit;
      throw err;
    }
  })());
});
