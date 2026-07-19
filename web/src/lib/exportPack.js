// Export EVERYTHING the server holds for a surah to the user's device.
//
// The server does the real work: GET /api/export?surah=N streams one ZIP with
// the AI audio + word-timings in every language (meaning, long + short tafsir),
// all transcripts, the human source recordings, the app recitation files, and
// the surah text JSON (see backend/server.mjs streamSurahZip). This module just
// hands that ZIP to the platform:
//   1. Phone-sized exports + Web Share support -> fetch the blob and open the
//      native share sheet ("Save to Files", AirDrop, ...).
//   2. Otherwise -> a plain <a href> download; the BROWSER streams it to disk,
//      so even a very large ZIP never sits in page memory.
import { AUDIO_BASE } from './data.js'

// Above this size we skip the share-sheet path (it requires the whole blob in
// memory) and go straight to the streamed download.
const SHARE_MAX_BYTES = 250e6

export async function exportSurahAll(surah) {
  const url = `${AUDIO_BASE}/api/export?surah=${surah}`
  // Size preview (no data read server-side) to pick the hand-off path.
  let bytes = 0
  try {
    const r = await fetch(`${url}&list=1`)
    if (r.ok) bytes = (await r.json()).bytes || 0
  } catch { /* preview is best-effort */ }

  const zipName = `QuranHakim-surah${String(surah).padStart(3, '0')}-all.zip`
  const wantShare = typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [new File([new Blob(['x'])], zipName, { type: 'application/zip' })] })

  if (wantShare && bytes > 0 && bytes < SHARE_MAX_BYTES) {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`export ${r.status}`)
      const file = new File([await r.blob()], zipName, { type: 'application/zip' })
      await navigator.share({ files: [file], title: zipName })
      return 'shared'
    } catch (e) {
      if (e?.name === 'AbortError') return 'shared' // user closed the sheet
      /* fall through to streamed download */
    }
  }
  const a = document.createElement('a')
  a.href = url
  a.download = zipName // server also sets Content-Disposition
  document.body.appendChild(a)
  a.click()
  a.remove()
  return 'downloaded'
}
