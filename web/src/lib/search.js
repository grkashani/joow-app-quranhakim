// Client-side full-text search over the Quran corpus (Arabic + Persian + English).
import { loadSurahIndex, loadSurah } from './data.js'

// Strip Arabic diacritics (harakat/tanwin/tashkeel) + normalize alef/ya/ta-marbuta
// so "الرحمن" matches "الرَّحْمَٰن", etc.
const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g
export function normAr(s) {
  return (s || '')
    .replace(DIACRITICS, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ی')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ة/g, 'ه')
    .replace(/‌/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
const normLatin = (s) => (s || '').toLowerCase().trim()

let ALL = null // [{surah, nameFa, nameEn, n, ar, fa, en, arN}]
let loadingPromise = null

export async function loadCorpus(onProgress) {
  if (ALL) return ALL
  if (loadingPromise) return loadingPromise
  loadingPromise = (async () => {
    const index = await loadSurahIndex()
    const rows = []
    let done = 0
    // load sequentially in small batches to keep memory/UX smooth
    for (const s of index) {
      const data = await loadSurah(s.num)
      for (const a of data.ayahs) {
        rows.push({
          surah: s.num, nameFa: s.nameFa, nameEn: s.nameEn,
          n: a.n, ar: a.ar, fa: a.fa, en: a.en, arN: normAr(a.ar),
        })
      }
      done++
      onProgress?.(done, index.length)
    }
    ALL = rows
    return ALL
  })()
  return loadingPromise
}

// Search across selected fields; returns up to `limit` matches with highlight ranges.
export async function search(query, { fields = ['ar', 'fa', 'en'], limit = 200 } = {}, onProgress) {
  const rows = await loadCorpus(onProgress)
  const q = query.trim()
  if (!q) return { total: 0, results: [] }
  const qAr = normAr(q)
  const qLat = normLatin(q)
  const results = []
  for (const r of rows) {
    let hit = null
    if (fields.includes('ar') && qAr && r.arN.includes(qAr)) hit = { field: 'ar', text: r.ar }
    else if (fields.includes('fa') && r.fa && normAr(r.fa).includes(qAr)) hit = { field: 'fa', text: r.fa }
    else if (fields.includes('en') && qLat && normLatin(r.en).includes(qLat)) hit = { field: 'en', text: r.en }
    if (hit) {
      results.push({ surah: r.surah, nameFa: r.nameFa, nameEn: r.nameEn, n: r.n, ...hit, ar: r.ar, fa: r.fa, en: r.en })
      if (results.length >= limit) break
    }
  }
  return { total: results.length, capped: results.length >= limit, results }
}

// Lightweight keyword ranking used by quranGPT retrieval: score ayahs by how many
// query tokens appear in their (normalized) text across all languages.
export async function rankAyahs(query, { limit = 6 } = {}) {
  const rows = await loadCorpus()
  const qAr = normAr(query)
  const tokens = [...new Set(qAr.split(' ').filter((t) => t.length > 1))]
  const latTokens = [...new Set(normLatin(query).split(/\s+/).filter((t) => t.length > 2))]
  if (!tokens.length && !latTokens.length) return []
  const scored = []
  for (const r of rows) {
    let score = 0
    const hay = r.arN + ' ' + normAr(r.fa)
    for (const t of tokens) if (hay.includes(t)) score += 1
    const en = normLatin(r.en)
    for (const t of latTokens) if (en.includes(t)) score += 1
    if (score > 0) scored.push({ score, r })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((x) => x.r)
}
