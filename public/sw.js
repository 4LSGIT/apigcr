// Minimal service worker — enables PWA install only. NO caching by design:
// YisraCase serves live, JWT-authenticated data; caching here would serve
// stale case data and break auth. Network passthrough only.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () {
  // No respondWith() → browser performs its normal network fetch.
});