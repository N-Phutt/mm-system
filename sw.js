// Maintenance System service worker
// - App shell (index.html etc.): served instantly from cache, refreshed in the background;
//   when a newer version is downloaded the page is told so it can offer a reload.
// - CDN files (versioned supabase-js, Google Fonts): cache-first — they never change.
// - Supabase API traffic is never cached.
const CACHE = 'ms-shell-v26';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

const sig = r => r ? [r.headers.get('etag'), r.headers.get('last-modified'), r.headers.get('content-length')].join('|') : '';
const FLAG = './__app-updated';
async function notifyUpdate() {
  await (await caches.open(CACHE)).put(FLAG, new Response('1'));            // remembered until a page picks it up
  const cs = await self.clients.matchAll({ type: 'window' }); cs.forEach(c => c.postMessage({ type: 'app-update' }));
}
self.addEventListener('message', e => {                                       // page says hello after it has loaded
  if (e.data?.type !== 'hello') return;
  e.waitUntil(caches.open(CACHE).then(async c => { if (await c.match(FLAG)) { await c.delete(FLAG); e.source?.postMessage({ type: 'app-update' }); } }));
});

self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.hostname.endsWith('supabase.co')) return;
  const same = u.origin === self.location.origin;
  const cdn = /(jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)$/.test(u.hostname);
  if (!same && !cdn) return;

  if (cdn) { // immutable versioned assets: cache first
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok || r.type === 'opaque') { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return r; })));
    return;
  }
  const isShell = req.mode === 'navigate' || /\/(index\.html)?$/.test(u.pathname);
  const key = isShell ? './index.html' : req;
  const work = (async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key, { ignoreSearch: true });
    const net = fetch(req, { cache: 'no-cache' }).then(async r => {
      if (r.ok) { const changed = isShell && cached && sig(r) !== sig(cached); await cache.put(key, r.clone()); if (changed) await notifyUpdate(); }
      return r;
    }).catch(() => null);
    if (cached) return { resp: cached, net };                 // instant open, refresh in background
    const r = await net; return { resp: r || (isShell ? await cache.match('./index.html') : Response.error()), net };
  })();
  e.respondWith(work.then(x => x.resp));
  e.waitUntil(work.then(x => x.net));
});
