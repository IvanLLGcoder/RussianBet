// Préfixe de publication déduit de la portée du service worker (« / » ou « /paris/ »).
const BASE = new URL(self.registration.scope).pathname;
// Change ce numéro à chaque déploiement qui modifie l'enveloppe de l'app.
// Le préfixe évite de toucher aux caches d'un autre site servi sur le même domaine.
const CACHE_PREFIX = 'duyka-paris-';
const CACHE_NAME = `${CACHE_PREFIX}app-shell-v3`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const shellResponse = await fetch(BASE);
    if (!shellResponse.ok) throw new Error('Could not fetch the app shell for offline use.');
    await cache.put(BASE, shellResponse.clone());
    const shell = await shellResponse.text();
    const assets = [...shell.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+\.(?:js|css))"/g)]
      .map((match) => match[1]);
    await cache.addAll([
      `${BASE}manifest.webmanifest`,
      `${BASE}icon-192.png`,
      `${BASE}icon-512.png`,
      `${BASE}maskable-512.png`,
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
      .filter((key) => key !== CACHE_NAME && (key.startsWith(CACHE_PREFIX) || key.startsWith('app-shell-')))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin
    || !url.pathname.startsWith(BASE) || url.pathname === `${BASE}api` || url.pathname.startsWith(`${BASE}api/`)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      let response;
      try {
        response = await fetch(request);
      } catch {
        return (await caches.match(BASE)) ?? Response.error();
      }
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(BASE, response.clone());
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
    icon: `${BASE}notification.svg`,
    badge: `${BASE}notification.svg`,
    tag: `${notification.type}-${notification.marketId}`,
    data: { url: notification.marketId ? `${BASE}market/${encodeURIComponent(notification.marketId)}` : BASE },
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
