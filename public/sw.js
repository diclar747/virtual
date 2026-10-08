// Bump BUILD together with the ?v= of the page assets so every release replaces the cached shell.
const BUILD = '20261009-8';
const SHELL = `shell-${BUILD}`;
const VOICE = 'voice-v1';
const FONTS = 'fonts-v1';
const ASSETS = ['/', `/styles.css?v=${BUILD}`, `/conversation.js?v=${BUILD}`, '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(names => Promise.all(names.filter(name => ![SHELL, VOICE, FONTS].includes(name)).map(name => caches.delete(name))))
    .then(() => self.clients.claim()));
});

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
  return response;
}

// The page itself always comes from the network when it answers quickly, so a new release shows
// up at once; the cached copy only covers a slow or missing connection.
async function pageFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) cache.put('/', response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match('/');
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return event.respondWith(cacheFirst(FONTS, request));
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api/speak') return event.respondWith(cacheFirst(VOICE, request));
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
  if (request.mode === 'navigate') return event.respondWith(pageFirst(request));
  event.respondWith(cacheFirst(SHELL, request));
});
