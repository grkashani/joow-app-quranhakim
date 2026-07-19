// Quran Hakim service worker: serve downloaded data from the local cache.
// - AUDIO (large, immutable): cache-first — instant + offline.
// - TRANSCRIPTS/DATA (small JSON, can be regenerated/improved server-side):
//   network-first, falling back to cache offline; a fresh copy also REFRESHES
//   the cached one so downloaded users don't keep stale transcripts forever.
// Cache name must match web/src/lib/downloads.js.
const CACHE = 'jq-audio-v1'
const AUDIO = ['/recitation/', '/reciters/', '/tafsir/', '/tafsir-tts/']
const FRESH = ['/transcripts/', '/data/']

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
