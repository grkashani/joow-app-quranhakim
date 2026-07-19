// Spoken-meaning + short-tafsir audio helpers for the new reader model.
// STATIC-FIRST then get-or-create, mirroring tts.js getTtsUrl: play the cached
// mp3 straight from nginx when it exists; otherwise ask the backend to make it.
// A 503 means "audio isn't ready yet" — the reader shows the honest "being
// prepared" note and skips the step, it NEVER hard-crashes playback.
import { AUDIO_BASE } from './data.js'

const pad3 = (n) => String(n).padStart(3, '0')

// Exact meaning audio for one ayah in one language.
//   1) HEAD /meaning-tts/<lang>/<c3>/<c3>_<v3>.mp3 — cached file, play instantly.
//   2) GET  /api/meaning-audio?surah&ayah&lang -> { url } on success,
//      or HTTP 503 { error:"not_ready" } while it's still being prepared.
// `ann` selects which variant to play: true (default) keeps the translator's
// clarifying [..]/(..) insertions; false uses the `.noann` variant with them
// removed. The backend serves both (`&ann=1|0` on the get-or-create endpoint).
export async function getMeaningUrl(surah, ayah, lang, ann = true) {
  const suffix = ann ? '' : '.noann'
  const staticUrl = `${AUDIO_BASE}/meaning-tts/${lang}/${pad3(surah)}/${pad3(surah)}_${pad3(ayah)}${suffix}.mp3`
  // Gate on the `.words.json` karaoke sidecar (written with the mp3), not the mp3 alone,
  // so a clip without word timings is regenerated instead of played un-highlightable.
  // A GET (not HEAD): the service worker only intercepts GETs, so this works offline
  // from the download cache — and it warms the sidecar cache for the reader.
  try {
    const h = await fetch(staticUrl.replace(/\.mp3$/, '.words.json'))
    if (h.ok) return staticUrl
  } catch { /* fall through to get-or-create */ }
  let r
  try {
    r = await fetch(`${AUDIO_BASE}/api/meaning-audio?surah=${surah}&ayah=${ayah}&lang=${encodeURIComponent(lang)}&ann=${ann ? 1 : 0}`)
  } catch (err) {
    // Network unreachable (offline): treat as "not ready" so the reader skips the
    // step with its honest note instead of halting the whole read-along.
    const e = new Error('offline'); e.status = 503; throw e
  }
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.url) { const e = new Error(d.error || `meaning ${r.status}`); e.status = r.status; throw e }
  return d.url.startsWith('http') ? d.url : `${AUDIO_BASE}${d.url}`
}

// Short-tafsir audio — the source may not exist yet (owner is still deciding it).
// GET /api/tafsir-short-audio?surah&ayah&lang -> { url } or HTTP 503. A 503 (which
// may be the norm for now) is expected and must degrade gracefully, never break
// the playback chain.
export async function getShortTafsirUrl(surah, ayah, lang) {
  const r = await fetch(`${AUDIO_BASE}/api/tafsir-short-audio?surah=${surah}&ayah=${ayah}&lang=${encodeURIComponent(lang)}`)
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.url) { const e = new Error(d.error || `short-tafsir ${r.status}`); e.status = r.status; throw e }
  return d.url.startsWith('http') ? d.url : `${AUDIO_BASE}${d.url}`
}
