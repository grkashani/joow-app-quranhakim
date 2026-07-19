// Multi-tafsir registry + URL builders.
// Tafsirs are described in /data/tafsirs.json (author, language, audio pattern, ...).
import { AUDIO_BASE } from './data.js'

const base = import.meta.env.BASE_URL || '/'
const pad3 = (n) => String(n).padStart(3, '0')

let cache = null
export async function loadTafsirs() {
  if (cache) return cache
  const res = await fetch(`${base}data/tafsirs.json`)
  const data = await res.json()
  cache = (data.tafsirs || []).filter((t) => t.enabled !== false)
  return cache
}

// This app is DEDICATED to one tafsir (Bazargan — "Quran Hakim"); other tafsirs
// ship as their own mini-apps. The registry schema stays multi-tafsir (shared engine).
export async function getDedicatedTafsir() {
  const list = await loadTafsirs()
  return list.find((t) => t.id === 'bazargan') || list[0] || null
}

function fill(pattern, surah, ayah) {
  return pattern
    .replaceAll('{c3}', pad3(surah)).replaceAll('{v3}', pad3(ayah))
    .replaceAll('{c}', String(surah)).replaceAll('{v}', String(ayah))
}

// Absolute audio URL for a tafsir clip (backend-hosted, or a direct URL).
export function tafsirAudioUrlFor(tafsir, surah, ayah) {
  const p = fill(tafsir.audio.pattern, surah, ayah)
  return p.startsWith('http') ? p : `${AUDIO_BASE}${p}`
}

// Relative path (also used as offline cache key).
export function tafsirPathFor(tafsir, surah, ayah) {
  return fill(tafsir.audio.pattern, surah, ayah)
}

// Where the (server-batch) transcript JSON lives, if any.
export function transcriptUrlFor(tafsir, surah, ayah) {
  if (!tafsir.transcript?.pattern) return null
  const p = fill(tafsir.transcript.pattern, surah, ayah)
  return p.startsWith('http') ? p : `${AUDIO_BASE}${p}`
}
