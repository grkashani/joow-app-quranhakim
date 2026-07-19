// Offline audio downloads.
// Web: uses the Cache Storage API (good for per-surah packs).
// Native (Capacitor): the same UI drives the Filesystem downloader (wired in the app build).
import { loadSurahIndex, AUDIO_BASE } from './data.js'
import { recitationPath, tafsirPath, recitationAudioUrl, tafsirAudioUrl } from './data.js'

const CACHE = 'jq-audio-v1'
const supported = typeof caches !== 'undefined'

async function cache() { return caches.open(CACHE) }

// Cache key for a backend-relative path = the on-origin pathname the app actually requests,
// i.e. base-prefixed on a subpath deploy (/hakim/tafsir/...) and origin-stripped on native.
// Keeps the download index, deletes, and the service worker's cache-first lookups in agreement.
const cacheKey = (relPath) => new URL(`${AUDIO_BASE}${relPath}`, location.origin).pathname

// Which surahs are fully downloaded, per type. Returns a Set of `${type}:${surah}`.
export async function downloadedSet() {
  if (!supported) return new Set()
  const c = await cache()
  const keys = await c.keys()
  const paths = new Set(keys.map((r) => new URL(r.url).pathname))
  const index = await loadSurahIndex()
  const done = new Set()
  for (const s of index) {
    let tAll = true, rAll = true
    for (let v = 1; v <= s.ttlVer; v++) {
      if (!paths.has(cacheKey(tafsirPath(s.num, v)))) tAll = false
      if (!paths.has(cacheKey(recitationPath(s.num, v)))) rAll = false
      if (!tAll && !rAll) break
    }
    if (tAll) done.add(`tafsir:${s.num}`)
    if (rAll) done.add(`recitation:${s.num}`)
  }
  return done
}

export async function estimateStorage() {
  if (navigator.storage?.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    return { usage, quota }
  }
  return { usage: 0, quota: 0 }
}

// Download one surah's audio for a type ('tafsir' | 'recitation'), reporting progress.
export async function downloadSurah(type, surah, ttlVer, onProgress, signal) {
  if (!supported) throw new Error('offline cache not supported in this browser')
  const c = await cache()
  const url = type === 'tafsir' ? tafsirAudioUrl : recitationAudioUrl
  for (let v = 1; v <= ttlVer; v++) {
    if (signal?.aborted) throw new Error('cancelled')
    const u = url(surah, v)
    const path = new URL(u, location.origin).pathname
    if (!(await c.match(path))) {
      const res = await fetch(u)
      if (res.ok) await c.put(path, res.clone())
    }
    onProgress?.(v, ttlVer)
  }
}

// Download EVERYTHING the server has: all recitation + all tafsir audio (from the
// surah index) plus every generated transcript/spoken-translation (from the server
// manifest). Resumable — already-cached files are skipped — and cancellable.
export async function downloadAll(onProgress, signal) {
  if (!supported) throw new Error('offline cache not supported in this browser')
  // Ask the browser to make our storage durable (not evictable under disk pressure).
  // Granted automatically for installed/frequently-used sites; harmless if denied.
  try { await navigator.storage?.persist?.() } catch { /* best-effort */ }
  const index = await loadSurahIndex()
  const files = []
  for (const s of index) for (let v = 1; v <= s.ttlVer; v++) files.push(recitationPath(s.num, v), tafsirPath(s.num, v))
  try {
    const m = await (await fetch(`${AUDIO_BASE}/api/manifest`)).json()
    files.push(...(m.transcripts || []), ...(m.tts || []))
  } catch { /* manifest unreachable -> audio-only */ }
  const c = await cache()
  let done = 0, failed = 0
  const queue = [...files]
  async function worker() {
    while (queue.length) {
      if (signal?.aborted) return
      const p = queue.shift()
      const key = cacheKey(p)
      try {
        if (!(await c.match(key))) {
          const res = await fetch(`${AUDIO_BASE}${p}`)
          if (res.ok) await c.put(key, res.clone())
          else failed++
        }
      } catch { failed++ }
      done++
      onProgress?.(done, files.length, failed)
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker)) // 4 parallel fetches
  if (signal?.aborted) throw new Error('cancelled')
  return { done, total: files.length, failed }
}

// ---- Global "download everything" tracker ----
// Lives at module level so it survives route changes (the Downloads page can leave
// and re-attach), can't be double-started, and — via a localStorage flag — resumes
// automatically after a page reload or closed tab. Cached files skip instantly.
const DL_FLAG = 'jq.dlAllActive'
let _all = null // { done, total, failed, ctrl }
const _subs = new Set()
const _notify = () => { const s = getAllProgress(); _subs.forEach((f) => f(s)) }
export const getAllProgress = () => (_all ? { done: _all.done, total: _all.total, failed: _all.failed } : null)
export function subscribeAll(fn) { _subs.add(fn); return () => _subs.delete(fn) }
export function cancelDownloadAll() { localStorage.removeItem(DL_FLAG); _all?.ctrl.abort() }
export async function startDownloadAll() {
  if (_all) return // already running — never double-start
  const ctrl = new AbortController()
  _all = { done: 0, total: 0, failed: 0, ctrl }
  localStorage.setItem(DL_FLAG, '1')
  _notify()
  let completed = false
  try {
    await downloadAll((done, total, failed) => {
      if (!_all) return
      Object.assign(_all, { done, total, failed })
      if (done % 10 === 0 || done === total) _notify()
    }, ctrl.signal)
    completed = true
  } catch { /* cancelled or fatal */ }
  if (completed) localStorage.removeItem(DL_FLAG) // finished: stop auto-resuming
  _all = null
  _notify()
}
// Called once at app boot: continue an interrupted "download everything".
export function resumeDownloadAllIfPending() {
  try { if (localStorage.getItem(DL_FLAG) && !_all) startDownloadAll() } catch { /* no cache support */ }
}

export async function deleteSurah(type, surah, ttlVer) {
  if (!supported) return
  const c = await cache()
  const path = type === 'tafsir' ? tafsirPath : recitationPath
  for (let v = 1; v <= ttlVer; v++) await c.delete(cacheKey(path(surah, v)))
}

export async function deleteAll() {
  if (supported) await caches.delete(CACHE)
}
