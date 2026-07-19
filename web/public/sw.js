// Quran Hakim service worker: serve downloaded data from the local cache.
// - AUDIO (large, immutable): cache-first — instant + offline.
// - TRANSCRIPTS/DATA (small JSON, can be regenerated/improved server-side):
//   network-first, falling back to cache offline; a fresh copy also REFRESHES
//   the cached one so downloaded users don't keep stale transcripts forever.
// Cache name must match web/src/lib/downloads.js.
// v2: the AI-TTS clips (meaning + tafsir) are REGENERABLE — a clip and its
// `.words.json` karaoke sidecar are written together and can be re-synthesised
// (e.g. to add word timings). Caching the mp3 cache-first served STALE audio whose
// sidecar was missing → no word highlight. So the TTS trees are now network-first
// (fresh + consistent, offline still falls back), and old caches are purged.
const CACHE = 'jq-audio-v2'
// Deploy base this SW is scoped to, derived from its own URL ('/hakim/sw.js' -> '/hakim',
// '/sw.js' -> ''). Keeps the cache prefixes aligned with the base-prefixed request paths
// (e.g. /hakim/recitation/...) without hardcoding the subpath.
const BASE = self.location.pathname.replace(/\/sw\.js$/, '')
// Immutable human audio: cache-first (instant + offline).
const AUDIO = ['/recitation/', '/reciters/', '/tafsir/'].map((p) => BASE + p)
// Regenerable / improvable: network-first (revalidate, refresh cached copy, offline-fallback).
// Includes the AI-TTS clips + their word-timing sidecars so a played clip always
// matches its timings.
const FRESH = ['/transcripts/', '/data/', '/tafsir-tts/', '/meaning-tts/'].map((p) => BASE + p)

self.addEventListener('install', () => self.skipWaiting())
// v1 -> v2: MIGRATE the user's downloads instead of purging them. Immutable human
// audio (recitation/reciters/tafsir source) and transcripts/data are copied into
// the new cache; only the regenerable TTS clips (which may predate the word-timing
// sidecars and would play un-highlightable) are dropped and re-fetched fresh.
async function migrateCaches() {
  const keys = await caches.keys()
  const cur = await caches.open(CACHE)
  for (const k of keys) {
    if (k === CACHE) continue
    const old = await caches.open(k)
    for (const req of await old.keys()) {
      const p = new URL(req.url).pathname
      if (/\/(tafsir-tts|meaning-tts)\//.test(p)) continue // regenerable: drop
      if (!(await cur.match(req))) {
        const res = await old.match(req)
        if (res) await cur.put(req, res)
      }
    }
    await caches.delete(k)
  }
}
self.addEventListener('activate', (e) => e.waitUntil(
  Promise.all([self.clients.claim(), migrateCaches()])
))

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
