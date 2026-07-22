// Community comments client. Anyone can comment on a surah (ayah = 0) or an ayah.
// Same origin rules as audio: relative on web (nginx / Vite proxy), absolute on native.
import { AUDIO_BASE } from './data.js'
import { getToken } from './auth.js'

const API = AUDIO_BASE // '' on web, 'https://quranner.com' in the Capacitor app

export async function fetchComments(surah, ayah = 0) {
  const r = await fetch(`${API}/api/comments?surah=${surah}&ayah=${ayah}`)
  if (!r.ok) throw new Error(`comments ${r.status}`)
  return (await r.json()).comments || []
}

// Map of { <ayah>: count } for a whole surah (ayah 0 = surah-level). Best-effort.
export async function fetchCommentCounts(surah) {
  try {
    const r = await fetch(`${API}/api/comments?surah=${surah}&counts=1`)
    if (!r.ok) return {}
    return (await r.json()).counts || {}
  } catch { return {} }
}

export async function postComment(surah, ayah, name, text, media) {
  const token = getToken()
  const r = await fetch(`${API}/api/comments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ surah, ayah: ayah || 0, name, text, ...(media && media.length ? { media } : {}) }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `post ${r.status}`)
  return d.comment
}

// Stream ONE media blob (image / voice / video / file) to the server, which
// stores it and returns a ref { id, url, type, mime, name, dur, bytes } to attach
// to a comment. Also feeds the knowledge-graph corpus (tagged by ayah).
export async function uploadContrib(surah, ayah, blob, opts = {}) {
  const token = getToken()
  const qs = new URLSearchParams({ surah: String(surah), ayah: String(ayah || 0) })
  if (opts.name) qs.set('name', String(opts.name).slice(0, 120))
  if (opts.dur) qs.set('dur', String(Math.round(opts.dur)))
  const r = await fetch(`${API}/api/contrib/upload?${qs.toString()}`, {
    method: 'POST',
    headers: { 'content-type': blob.type || 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: blob,
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `upload ${r.status}`)
  return d
}

// Absolute src for a stored media ref (relative on web, prefixed on native).
export function mediaSrc(url) {
  return url && url.startsWith('/api/') ? `${API}${url}` : url
}
