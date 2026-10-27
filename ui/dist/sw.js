/* HUGO Eye service worker — app shell only.
 * NEVER caches /api/* or /media/* (private live video and data always come
 * from the network). Static build assets are cache-first with versioned URLs;
 * navigation falls back to the cached shell when offline. */
const SHELL_CACHE = 'hugo-eye-shell-v1'

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(['/']).then(() => self.skipWaiting())))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  // hard privacy rule: the app shell worker never touches private data paths
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return
  if (event.request.method !== 'GET') return

  // versioned build assets: cache-first
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(hit => hit ?? fetch(event.request).then(res => {
        const copy = res.clone()
        caches.open(SHELL_CACHE).then(cache => cache.put(event.request, copy))
        return res
      })),
    )
    return
  }

  // navigations: network-first, fall back to the cached shell offline
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const copy = res.clone()
          caches.open(SHELL_CACHE).then(cache => cache.put('/', copy))
          return res
        })
        .catch(() => caches.match('/')),
    )
  }
})
