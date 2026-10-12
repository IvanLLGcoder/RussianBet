// Change ce numéro à chaque déploiement qui modifie l'enveloppe de l'app.
const CACHE_NAME = 'app-shell-v2';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const shellResponse = await fetch('/');
    if (!shellResponse.ok) throw new Error('Could not fetch the app shell for offline use.');
    await cache.put('/', shellResponse.clone());
    const shell = await shellResponse.text();
    const assets = [...shell.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)]
      .map((match) => match[1]);
    await cache.addAll([
      '/manifest.webmanifest',
      '/icon-192.png',
      '/icon-512.png',
      '/maskable-512.png',
      ...assets,
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Supprime aussi les caches de l'ancienne version du site (autre préfixe).
    await Promise.all(keys
      .filter((key) => key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin
    || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      let response;
      try {
        response = await fetch(request);
      } catch {
        return (await caches.match('/')) ?? Response.error();
      }
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put('/', response.clone());
      }
      return response;
    })());
    return;
  }

  if (['script', 'style', 'image', 'font'].includes(request.destination)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })());
  }
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  const notification = event.data.json();
  event.waitUntil(self.registration.showNotification(notification.title, {
    body: notification.body,
    icon: '/notification.svg',
    badge: '/notification.svg',
    tag: `${notification.type}-${notification.marketId}`,
    data: { url: notification.marketId ? `/market/${encodeURIComponent(notification.marketId)}` : '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(event.notification.data.url).catch(() => undefined);
        return;
      }
    }
    await self.clients.openWindow(event.notification.data.url);
  })());
});
