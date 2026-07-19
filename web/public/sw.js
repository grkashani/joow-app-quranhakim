// Quran Hakim service worker: serve downloaded data from the local cache.
// - AUDIO (large, immutable): cache-first — instant + offline.
// - TRANSCRIPTS/DATA (small JSON, can be regenerated/improved server-side):
//   network-first, falling back to cache offline; a fresh copy also REFRESHES
//   the cached one so downloaded users don't keep stale transcripts forever.
// Cache name must match web/src/lib/downloads.js.
const CACHE = 'jq-audio-v1'
// Deploy base this SW is scoped to, derived from its own URL ('/hakim/sw.js' -> '/hakim',
// '/sw.js' -> ''). Keeps the cache prefixes aligned with the base-prefixed request paths
// (e.g. /hakim/recitation/...) without hardcoding the subpath.
const BASE = self.location.pathname.replace(/\/sw\.js$/, '')
const AUDIO = ['/recitation/', '/reciters/', '/tafsir/', '/tafsir-tts/'].map((p) => BASE + p)
const FRESH = ['/transcripts/', '/data/'].map((p) => BASE + p)

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)
  const p = url.pathname
  if (AUDIO.some((x) => p.startsWith(x))) {
    e.respondWith(
      caches.open(CACHE).then((c) => c.match(p).then((hit) => hit || fetch(e.request)))
    )
    return
  }
  if (FRESH.some((x) => p.startsWith(x))) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        fetch(e.request.url, { cache: 'no-cache' }) // revalidate: skip the HTTP cache's max-age
          .then((res) => {
            if (res.ok) {
              const copy = res.clone() // clone BEFORE anything reads the body
              c.match(p).then((had) => { if (had) c.put(p, copy) }) // refresh only downloaded copies
            }
            return res
          })
          .catch(() => c.match(p).then((hit) => hit || Response.error()))
      )
    )
  }
})
