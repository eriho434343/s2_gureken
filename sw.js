// Service Worker - 昇進試験 学習PWA
// オフライン動作のため全ファイルをキャッシュ

const VERSION = 'v1.0.0-2026.05';
const CACHE_NAME = `shoshin-shiken-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './data/seed.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Cache first for our assets, network fallback
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // For seed.json, also try to update in background (network update)
        if (url.pathname.endsWith('/seed.json')) {
          fetch(req).then((res) => {
            if (res && res.ok) {
              caches.open(CACHE_NAME).then((c) => c.put(req, res.clone()));
            }
          }).catch(() => {});
        }
        return cached;
      }
      return fetch(req).then((res) => {
        // Cache same-origin successful responses
        if (res && res.ok && url.origin === location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (req.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
