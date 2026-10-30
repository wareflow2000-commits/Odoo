/* OW service worker: app-shell caching only. Remote business data is never cached here. */
'use strict';
const CACHE_NAME = 'ow-wms-shell-v13-9-59-r13';
const APP_SHELL = [
  './index.html',
  './manifest.webmanifest',
  './assets/logo.png',
  './style-base.css',
  './style-shell.css',
  './style-wms.css',
  './main.js',
  './core-api-supabase.js',
  './core-auth.js',
  './core-i18n.js',
  './core-lazy.js',
  './core-modal.js',
  './core-qr.js',
  './core-rbac.js',
  './core-registry.js',
  './core-router.js',
  './core-searchable-select.js',
  './core-sound.js',
  './core-store.js',
  './core-supabase.js',
  './core-toast.js',
  './core-ui.js',
  './core-utils.js',
  './comp-control-panel.js',
  './page-about.js',
  './page-apps.js',
  './page-calendar.js',
  './page-dashboard.js',
  './page-discuss.js',
  './page-facilities.js',
  './page-inventory.js',
  './page-orders.js',
  './page-profile.js',
  './page-reports.js',
  './page-settings.js',
  './page-stocktake.js',
  './page-sync.js',
  './page-transactions.js',
  './page-transfers.js',
  './jsqr.js',
  './qrcode-generator.js',
  './qr-reader.js',
  './qr-scanner.js',
  './SQLite-db.js',
  './supabase-client.js',
  './ui-apps-panel.js',
  './ui-navbar.js',
  './ui-user-menu.js'
];
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // cache.add()/addAll() may reuse a stale HTTP-cache response. Force a
      // network reload so a new service worker never pins an old module set.
      await Promise.all(APP_SHELL.map(async url => {
        const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Shell asset failed: ${url}`);
        await cache.put(url, response);
      }));
    }).then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => (key.startsWith('ow-wms-shell-') || key.startsWith('orshap-wms-shell-')) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request, { cache: 'no-cache' }).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put('./index.html', response.clone()));
      return response;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  const isAppAsset = /\.(?:js|css|png|webmanifest)$/.test(url.pathname);
  if (isAppAsset) {
    event.respondWith(fetch(request, { cache: 'no-cache' }).then(response => {
      if (response.ok && response.type === 'basic') caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request)));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok && response.type === 'basic') caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});
