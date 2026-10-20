// Oisecur service worker: de app opent ook zonder internet.
// HTML altijd eerst van het netwerk (zodat updates direct zichtbaar zijn); bibliotheken uit de cache.
const CACHE = 'oisecur-v2';
const SHELL = ['/app.html', '/manifest.json', '/icon-192.png', '/favicon-64.png'];
const CDN = ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js', 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all([...SHELL, ...CDN].map(u => c.add(new Request(u, { mode: u.startsWith('http') ? 'cors' : 'same-origin' })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  const isApp = url.origin === location.origin && (url.pathname === '/app.html' || url.pathname === '/app');
  if (isApp) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const k = r.clone(); caches.open(CACHE).then(c => c.put('/app.html', k)); } return r; })
      .catch(() => caches.match('/app.html')));
    return;
  }
  if (CDN.includes(req.url) || url.hostname === 'fonts.gstatic.com' || url.hostname === 'fonts.googleapis.com' || (url.origin === location.origin && /\.(png|ico|json)$/.test(url.pathname))) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok || r.type === 'opaque') { const k = r.clone(); caches.open(CACHE).then(c => c.put(req, k)); } return r; })));
  }
});

// Pushmeldingen (alarmen voor de beheerder, herinnering voor alleenwerkers)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { tekst: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.titel || 'Oisecur', {
    body: d.tekst || '', icon: '/icon-192.png', badge: '/favicon-64.png', tag: d.tag || 'oisecur', renotify: true,
    requireInteraction: !!d.urgent, vibrate: d.urgent ? [400, 150, 400, 150, 400] : [200], data: { url: d.url || '/app.html' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/app.html', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) if (c.url.includes('/app.html') && 'focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
