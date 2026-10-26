// Service worker: makes AskGoWhere installable and open fast.
// - The page itself: always try the network first, so new versions show up
//   straight away; fall back to the saved copy when offline.
// - App files (icons, map library): use the saved copy, refresh it in the background.
// - Search and routes (/api/...) and map tiles: never saved, always live.

const CACHE = 'askgowhere-v2';
const APP_FILES = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Delete caches from older versions of this file
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Live data: let the browser handle it normally
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // The page: network first, saved copy when offline
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy));
          return resp;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Our own files and the map library: saved copy first, refreshed in the background
  const isOwnFile = url.origin === self.location.origin;
  const isMapLibrary = url.hostname === 'unpkg.com';
  if (isOwnFile || isMapLibrary) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const saved = await cache.match(req);
        const fresh = fetch(req)
          .then((resp) => {
            if (resp.ok) cache.put(req, resp.clone());
            return resp;
          })
          .catch(() => saved);
        return saved || fresh;
      })
    );
  }
  // Everything else (map tiles, fonts): normal browser behaviour
});
