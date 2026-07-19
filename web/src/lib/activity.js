// Reading/listening activity log — the raw-event substrate for user insights.
//
// PRINCIPLE: store raw events, derive reports later. Every meaningful action
// becomes one small event; aggregation lives server-side (/api/activity/summary)
// so new reports never require new client code or re-instrumentation.
//
// Events (schema v:1, one JSON object each):
//   listen — one playback of one STEP clip (recite/meaning/tafsir of one ayah):
//     { v, type:'listen', ts, tzo, surah, ayah, kind, lang, mode?, reciter?,
//       secs (actually-heard seconds), dur (clip length), done (reached end),
//       speed }
//   read — time spent ON a surah screen (visibility-aware):
//     { v, type:'read', ts, tzo, surah, secs }
//
// Identity: an anonymous, stable per-device id (localStorage). The signed-in
// account id / shell display name ride along when present so future reports can
// group devices per member. Batched + flushed with sendBeacon so backgrounding
// or closing the app never loses the tail.
import { AUDIO_BASE } from './data.js'
import { cachedUser } from './auth.js'
import { getShellUser, isFramed } from './framed.js'

const DID_KEY = 'jq.did'
const QUEUE_KEY = 'jq.activityQueue'
const FLUSH_MS = 20_000
const FLUSH_AT = 20 // events
const MAX_QUEUE = 500

export function deviceId() {
  try {
    let id = localStorage.getItem(DID_KEY)
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      localStorage.setItem(DID_KEY, id)
    }
    return id
  } catch {
    return 'volatile'
  }
}

let queue = []
try { queue = JSON.parse(localStorage.getItem(QUEUE_KEY)) || [] } catch { queue = [] }
let flushTimer = 0

function persistQueue() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE))) } catch { /* private mode */ }
}

function identity() {
  const u = cachedUser()
  const s = isFramed() ? getShellUser() : null
  return {
    ...(u?.id ? { userId: u.id } : {}),
    ...(s?.name ? { shellName: s.name } : {}),
    ...(s?.id ? { shellId: s.id } : {}),
  }
}

function record(ev) {
  queue.push(ev)
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)
  persistQueue()
  if (queue.length >= FLUSH_AT) flush()
  else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
}

export function flush() {
  clearTimeout(flushTimer); flushTimer = 0
  if (!queue.length) return
  const batch = queue.splice(0, 100)
  persistQueue()
  const body = JSON.stringify({ did: deviceId(), ...identity(), events: batch })
  const url = `${AUDIO_BASE}/api/activity`
  // sendBeacon survives page hide/close; fetch(keepalive) is the fallback.
  let ok = false
  try { ok = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })) } catch { ok = false }
  if (!ok) {
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
      .catch(() => { queue = batch.concat(queue); persistQueue() }) // network down — retry later
  }
  if (queue.length) flushTimer = setTimeout(flush, FLUSH_MS)
}

const base = () => ({ v: 1, ts: new Date().toISOString(), tzo: -new Date().getTimezoneOffset() })

// ---- listen tracking: one open step at a time ----
// Reader calls stepStarted() whenever it points the audio element at a new
// clip; we accumulate ACTUALLY-HEARD seconds via addHeard() (driven by the
// audio element's timeupdate) and close the previous step automatically.
let openStep = null // { ctx, secs, dur, done }

export function stepStarted(ctx) {
  finalizeStep(false)
  openStep = { ctx, secs: 0, dur: 0, done: false }
}
export function addHeard(deltaSecs, clipDur) {
  if (!openStep || !isFinite(deltaSecs) || deltaSecs <= 0 || deltaSecs > 3) return
  openStep.secs += deltaSecs
  if (isFinite(clipDur) && clipDur > 0) openStep.dur = clipDur
}
export function stepEnded() { // clip reached its natural end
  if (openStep) openStep.done = true
  finalizeStep(true)
}
export function finalizeStep(fromEnded) {
  if (!openStep) return
  const { ctx, secs, dur, done } = openStep
  openStep = null
  if (secs < 1) return // ignore sub-second blips (skips, instant swaps)
  record({
    ...base(), type: 'listen',
    surah: ctx.surah, ayah: ctx.ayah, kind: ctx.kind, lang: ctx.lang,
    ...(ctx.mode ? { mode: ctx.mode } : {}),
    ...(ctx.reciter ? { reciter: ctx.reciter } : {}),
    secs: Math.round(secs * 10) / 10, dur: Math.round((dur || 0) * 10) / 10,
    done: !!(done || fromEnded), speed: ctx.speed || 1,
  })
}

// ---- read-time tracking: visible seconds on a surah screen ----
let readSurah = null
let readStart = 0
let readAccum = 0

function readFlush() {
  if (readSurah == null) return
  if (readStart) { readAccum += (Date.now() - readStart) / 1000; readStart = 0 }
  if (readAccum >= 3) {
    record({ ...base(), type: 'read', surah: readSurah, secs: Math.round(readAccum) })
  }
  readAccum = 0
}
export function readEnter(surah) {
  readFlush()
  readSurah = surah
  readStart = document.visibilityState === 'visible' ? Date.now() : 0
  readAccum = 0
}
export function readLeave() {
  readFlush()
  readSurah = null
}

// Pause/resume the read clock + flush the queue when the app hides (the last
// batch must not die with the tab).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (readSurah != null && readStart) { readAccum += (Date.now() - readStart) / 1000; readStart = 0 }
      finalizeStep(false)
      flush()
    } else if (readSurah != null && !readStart) {
      readStart = Date.now()
    }
  })
  window.addEventListener('pagehide', () => { readFlush(); finalizeStep(false); flush() })
}

// Summary for the insights UI (device-scoped).
export async function fetchSummary(surah) {
  const q = new URLSearchParams({ did: deviceId() })
  if (surah) q.set('surah', String(surah))
  // Framed with a member id -> insights follow the MEMBER across devices.
  const s = isFramed() ? getShellUser() : null
  if (s?.id) q.set('member', s.id)
  const r = await fetch(`${AUDIO_BASE}/api/activity/summary?${q}`)
  if (!r.ok) throw new Error(`summary ${r.status}`)
  return r.json()
}
