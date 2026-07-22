// Share ONE ayah as an interactive, playable unit.
//
// FRAMED (inside yQuran): hand off a `joow:external-share` of kind 'ayah'. The
// feed is media-only, so we also generate a branded CARD image (satisfies the
// post's media requirement); the ayah ref + embed URL let the feed upgrade that
// static card into the LIVE single-ayah player (multi-language, karaoke, speed).
// STANDALONE: native-share / copy the canonical embed URL.
import { isFramed, postToShell } from './framed.js'

export function ayahEmbedUrl(surah, ayah) {
  const origin = typeof location !== 'undefined' ? location.origin : 'https://quranner.com'
  return `${origin}/ayah/${surah}/${ayah}`
}

// A simple branded share card (canvas → PNG data URL). Kept text-light on purpose
// — the real ayah plays in the embed; this is just the feed's required thumbnail.
function buildAyahCard(surah, ayah, opts = {}) {
  try {
    const W = 1080, H = 1080
    const c = document.createElement('canvas'); c.width = W; c.height = H
    const g = c.getContext('2d')
    const grad = g.createLinearGradient(0, 0, W, H)
    grad.addColorStop(0, '#0f5b2c'); grad.addColorStop(1, '#15803d')
    g.fillStyle = grad; g.fillRect(0, 0, W, H)
    g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,0.97)'
    g.font = '700 96px system-ui, sans-serif'; g.fillText('قرآن حکیم', W / 2, 300)
    g.font = '600 60px system-ui, sans-serif'
    g.fillText(`${opts.surahName || 'Surah ' + surah} · ${opts.ayahLabel || 'Ayah'} ${ayah}`, W / 2, 470)
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 6
    g.beginPath(); g.arc(W / 2, 720, 90, 0, Math.PI * 2); g.stroke()
    g.fillStyle = 'rgba(255,255,255,0.97)'; g.beginPath()
    g.moveTo(W / 2 - 28, 680); g.lineTo(W / 2 - 28, 760); g.lineTo(W / 2 + 46, 720); g.closePath(); g.fill()
    g.font = '500 44px system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.92)'
    g.fillText(opts.playLabel || 'Play this ayah', W / 2, 900)
    return c.toDataURL('image/png')
  } catch { return null }
}

// Returns 'shared-to-yquran' | 'shared' | 'copied' | 'failed'.
export async function shareAyah(surah, ayah, opts = {}) {
  const caption = opts.caption || `${opts.surahName || 'Surah ' + surah} · ${opts.ayahLabel || 'Ayah'} ${ayah}`
  const url = ayahEmbedUrl(surah, ayah)
  if (isFramed()) {
    const imageDataUrl = buildAyahCard(surah, ayah, opts)
    const ok = postToShell({
      type: 'joow:external-share', kind: 'ayah',
      surah: Number(surah), ayah: Number(ayah),
      caption, url, imageDataUrl: imageDataUrl || undefined,
      lang: opts.lang || undefined,
    })
    if (ok) return 'shared-to-yquran'
  }
  if (typeof navigator !== 'undefined' && navigator.share) {
    try { await navigator.share({ title: caption, text: caption, url }); return 'shared' }
    catch (e) { if (e?.name === 'AbortError') return 'shared' }
  }
  try { await navigator.clipboard.writeText(url); return 'copied' } catch { /* no clipboard */ }
  return 'failed'
}
