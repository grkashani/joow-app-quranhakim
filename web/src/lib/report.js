// Shareable reading report — a branded card image built from the activity
// insights, plus a caption. The user shares it to yQuran's Social feed (which
// requires an image, not text-only) or to any app via the native share sheet.
//
// FRAMED (inside yQuran): post `joow:external-share` {imageDataUrl, caption} to
// the host; yQuran seeds its post composer so the user reviews and publishes.
// STANDALONE: navigator.share the PNG file (native sheet), else download it.
import { getShellUser, isFramed } from './framed.js'

const fmtDur = (secs) => {
  const s = Math.max(0, Math.round(secs || 0))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  const h = m / 60
  return `${h.toFixed(h < 10 ? 1 : 0)} hr`
}

const peakHourLabel = (hist) => {
  if (!Array.isArray(hist) || !hist.some((v) => v > 0)) return null
  let hi = 0
  for (let i = 1; i < hist.length; i++) if (hist[i] > hist[hi]) hi = i
  const band = hi < 5 ? 'late night' : hi < 12 ? 'the morning' : hi < 17 ? 'the afternoon' : hi < 21 ? 'the evening' : 'the night'
  return { hour: hi, band }
}

// Draw the report card on an offscreen canvas → PNG data URL. Square (1080) for
// broad social compatibility. Self-contained (no external fonts/images).
export function buildReportCard(insights, name) {
  const T = insights?.totals || {}
  const listenSecs = T.listenSecs || 0
  const readSecs = T.readSecs || 0
  const total = listenSecs + readSecs
  const peak = peakHourLabel(insights?.hourHistogram)

  const S = 1080
  const c = document.createElement('canvas')
  c.width = S; c.height = S
  const g = c.getContext('2d')

  // Background: deep-green gradient (the Quran Hakim / yQuran brand).
  const bg = g.createLinearGradient(0, 0, S, S)
  bg.addColorStop(0, '#0b5a2a'); bg.addColorStop(1, '#15803d')
  g.fillStyle = bg; g.fillRect(0, 0, S, S)
  // Soft glow.
  const glow = g.createRadialGradient(S / 2, S * 0.42, 40, S / 2, S * 0.42, S * 0.6)
  glow.addColorStop(0, 'rgba(255,255,255,0.10)'); glow.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = glow; g.fillRect(0, 0, S, S)

  g.textAlign = 'center'
  g.fillStyle = '#ffffff'

  // Header.
  g.font = "600 34px system-ui, sans-serif"
  g.globalAlpha = 0.85
  g.fillText('QURAN HAKIM', S / 2, 130)
  g.globalAlpha = 1
  g.font = "800 62px system-ui, sans-serif"
  g.fillText(name ? `${name}'s reading` : 'My reading', S / 2, 210)

  // Hero: total time.
  g.font = "800 150px system-ui, sans-serif"
  g.fillText(fmtDur(total), S / 2, 400)
  g.font = "500 36px system-ui, sans-serif"
  g.globalAlpha = 0.85
  g.fillText('with the Qur’an', S / 2, 452)
  g.globalAlpha = 1

  // Stat trio.
  const stats = [
    [String(T.ayahsHeard || 0), 'ayahs heard'],
    [String(T.listens || 0), 'plays'],
    [String(T.surahsTouched || 0), 'surahs'],
  ]
  const cols = [S * 0.24, S * 0.5, S * 0.76]
  stats.forEach(([n, label], i) => {
    g.font = "800 84px system-ui, sans-serif"
    g.fillText(n, cols[i], 640)
    g.font = "500 30px system-ui, sans-serif"
    g.globalAlpha = 0.82
    g.fillText(label, cols[i], 690)
    g.globalAlpha = 1
  })

  // Listening vs reading split + peak time.
  g.font = "500 34px system-ui, sans-serif"
  g.globalAlpha = 0.9
  g.fillText(`${fmtDur(listenSecs)} listening · ${fmtDur(readSecs)} reading`, S / 2, 800)
  if (peak) g.fillText(`Most often in ${peak.band}`, S / 2, 852)
  g.globalAlpha = 1

  // Footer brand.
  g.font = "700 34px system-ui, sans-serif"
  g.fillText('yQuran', S / 2, 980)
  g.font = "500 26px system-ui, sans-serif"
  g.globalAlpha = 0.8
  g.fillText('yquran.com', S / 2, 1020)
  g.globalAlpha = 1

  const caption = [
    name ? `${name}'s Qur’an reading so far:` : 'My Qur’an reading so far:',
    `• ${fmtDur(total)} with the Qur’an (${fmtDur(listenSecs)} listening, ${fmtDur(readSecs)} reading)`,
    `• ${T.ayahsHeard || 0} ayahs heard across ${T.surahsTouched || 0} surah(s)`,
    peak ? `• I read most often in ${peak.band}` : null,
    '',
    'Read & listen on yQuran → yquran.com  #Quran #yQuran',
  ].filter((x) => x != null).join('\n')

  return { dataUrl: c.toDataURL('image/png'), caption }
}

const dataUrlToFile = (dataUrl, filename) => {
  const [head, b64] = dataUrl.split(',')
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], filename, { type: mime })
}

// Share the report. Returns 'shared-to-yquran' | 'shared' | 'downloaded' | 'empty'.
export async function shareReport(insights, name) {
  if (!insights || !insights.totals || (!insights.totals.listenSecs && !insights.totals.readSecs)) return 'empty'
  const { dataUrl, caption } = buildReportCard(insights, name)

  // Framed inside yQuran: hand the card to the host to seed its Social composer.
  if (isFramed()) {
    const trusted = getShellHostOrigin()
    try {
      window.parent.postMessage({ type: 'joow:external-share', kind: 'reading-report', imageDataUrl: dataUrl, caption }, trusted || '*')
      return 'shared-to-yquran'
    } catch { /* fall through to native share */ }
  }

  // Standalone: native share sheet (image + caption), else download.
  const file = dataUrlToFile(dataUrl, 'quran-hakim-report.png')
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text: caption, title: 'My Qur’an reading' }); return 'shared' }
    catch (e) { if (e?.name === 'AbortError') return 'shared' }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url; a.download = 'quran-hakim-report.png'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return 'downloaded'
}

// The yQuran shell origin (for the origin-pinned postMessage). Prefer the shell
// user's known host; fall back to the document referrer's origin.
function getShellHostOrigin() {
  const su = getShellUser()
  void su
  try {
    const ref = document.referrer
    if (ref) return new URL(ref).origin
  } catch { /* no referrer */ }
  return 'https://yquran.com'
}
