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

export async function postComment(surah, ayah, name, text) {
  const token = getToken()
  const r = await fetch(`${API}/api/comments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ surah, ayah: ayah || 0, name, text }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `post ${r.status}`)
  return d.comment
}
