import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { shareAyah, ayahEmbedUrl } from '../lib/shareAyah.js'
import { loadSurah, recitationAudioUrl, tafsirAudioUrl, shortTafsirAudioUrl, getReciter, setReciter, loadReciters, AUDIO_BASE } from '../lib/data.js'
import { getDedicatedTafsir, getDedicatedShortTafsir } from '../lib/tafsir.js'
import { getCached, setCached, getServerTranscript } from '../lib/transcribe.js'
import { getTtsUrl } from '../lib/tts.js'

// Strip ElevenLabs [audio-event] tags (transcription artifacts like [coughs],
// [laughs]) from DISPLAYED tafsir text. They stay in the stored text so the TTS
// voice can still perform them — only the on-screen text is cleaned.
const stripEventTags = (s) => String(s || '')
  .replace(/\[(?:coughs?|laughs?|laughter|chuckles?|sighs?|clears throat|throat clearing|pause|silence|music|applause|breath(?:es|ing)?|inhales?|exhales?|sniffs?|gasps?|hmm+|uh+|um+|er+)\]/gi, '')
  .replace(/\s{2,}/g, ' ')
  .trim()
import { getMeaningUrl } from '../lib/meaning.js'
import { fetchCommentCounts } from '../lib/comments.js'
import Comments from '../components/Comments.jsx'
import Player from '../components/Player.jsx'
import EmbedControls from '../components/EmbedControls.jsx'
import { useI18n, LANGUAGES, dirOf } from '../lib/i18n.jsx'
import { getReaderSettings, READER_SETTINGS_EVENT, setMeaningLang, setTafsirMode, setReciteArabic, MEANING_LANGS } from '../lib/settings.js'
import * as activity from '../lib/activity.js'
import { buildGaps, gapMeta, gapTick, speechRate } from '../lib/gapSpeed.js'

// ---- Word-timing sidecars ----
// Each generated TTS clip ships a sidecar next to it: for `X.mp3` the per-word
// timings live at `X.words.json` -> { words:[{ w, s, e }], dur } (s/e = seconds).
// MEANING clips have them today; recitation (everyayah) and some tafsir clips
// 404 — that's expected and degrades to a whole-line highlight. We fetch once per
// mp3 URL and cache the PROMISE so a step never re-fetches its own sidecar.
const wordsCache = new Map()
function loadWords(mp3Url, sidecarUrl) {
  const key = sidecarUrl || mp3Url
  if (wordsCache.has(key)) return wordsCache.get(key)
  const sidecar = sidecarUrl || mp3Url.replace(/\.mp3(\?.*)?$/, '.words.json')
  const p = fetch(sidecar)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d && Array.isArray(d.words) && d.words.length ? d : null))
    .catch(() => null)
  wordsCache.set(key, p)
  return p
}

// Small JSON fetch cache for the sentence-anchor layer (segments + anchors) —
// used by the language switch to land on the SAME SENTENCE in the new language.
const jsonCache = new Map()
function loadJson(url) {
  if (jsonCache.has(url)) return jsonCache.get(url)
  const p = fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  jsonCache.set(url, p)
  return p
}

// Sentence-accurate seek target for a tafsir language switch (v2 design §C).
// Given the OLD clip (url + position + lang) and the NEW clip (url + lang),
// find the sentence being spoken, map it through the cross-language anchor
// units, and return the corresponding start time in the new clip — or null
// (caller falls back to proportional seek) when any piece is missing.
async function anchorSeekTarget(oldUrl, oldTime, oldLang, newUrl, newLang, anchorsUrl) {
  try {
    const [oldSegs, newSegs, anchors] = await Promise.all([
      loadJson(oldUrl.replace(/\.mp3(\?.*)?$/, '.segments.json')),
      loadJson(newUrl.replace(/\.mp3(\?.*)?$/, '.segments.json')),
      loadJson(anchorsUrl),
    ])
    const os = oldSegs?.segments, ns = newSegs?.segments, units = anchors?.units
    if (!os?.length || !ns?.length || !units?.length) return null
    // sentence currently being spoken (last segment whose start <= oldTime)
    let idx = 0
    for (let i = 0; i < os.length; i++) { if (os[i].s <= oldTime) idx = i; else break }
    const unit = units.find((u) => Array.isArray(u[oldLang]) && idx >= u[oldLang][0] && idx <= u[oldLang][1])
    if (!unit || !Array.isArray(unit[newLang])) return null
    // keep the position WITHIN the unit too (a unit can span several sentences)
    const [os0, os1] = unit[oldLang]
    const [nsO, ns1] = unit[newLang]
    const frac = os1 > os0 ? (idx - os0) / (os1 - os0 + 1) : 0
    const target = Math.min(ns1, nsO + Math.floor(frac * (ns1 - nsO + 1)))
    return ns[target] ? ns[target].s : null
  } catch { return null }
}

// Renders the ACTIVE block's spoken text as tappable word spans carrying their
// own [data-s,data-e] timings — the karaoke substrate. The Reader's rAF sync
// loop reads these spans by class/data-attr and toggles highlight classes
// directly on the DOM, so highlighting never re-renders React. Tapping a word
// seeks the audio to that word's start (two-way sync). Only the active block is
// rendered this way; every other ayah stays plain text (cheap).
function KaraokeText({ words, onSeekWord }) {
  return words.map((w, i) => (
    <span key={i}>
      <span
        className="jq-w"
        data-s={w.s}
        data-e={w.e}
        onClick={(e) => { e.stopPropagation(); onSeekWord(w.s) }}
      >
        {w.w}
      </span>
      {i < words.length - 1 ? ' ' : ''}
    </span>
  ))
}

// ===== The new interaction model =====
// The reader plays a per-ayah SEQUENCE and auto-scrolls + highlights as it reads,
// in ONE meaning language chosen in the Settings drawer. Per ayah the step queue is:
//   [recite]  Arabic recitation      (only if "Recite Arabic first" is ON)
//   [meaning] the exact meaning       (always)
//   [tafsir]  long OR short commentary (only if Tafsir is Long/Short)
// When the last step of an ayah ends we AUTO-ADVANCE to the next ayah, through the
// whole surah. A step whose audio is unavailable (503) is skipped with an honest
// "being prepared" note — it never blocks the chain. Tapping any ayah starts
// playback from that ayah with the current settings.

const pad3 = (n) => String(n).padStart(3, '0')
// Recitation word-timings (imported from free community data, NOT ElevenLabs):
// /recitation-timings/<reciterId>/<c3>_<v3>.words.json — same karaoke schema as
// the TTS sidecars. Missing file (uncovered reciter/ayah) -> whole-line highlight.
const recitationWordsUrl = (surah, ayah) =>
  `${AUDIO_BASE}/recitation-timings/${getReciter()}/${pad3(surah)}_${pad3(ayah)}.words.json`
// Cross-language sentence anchors for a tafsir ayah (v2 design §C).
const tafsirAnchorsUrl = (tafsirId, surah, ayah) =>
  `${AUDIO_BASE}/tafsir-tts/${tafsirId}/_anchors/${pad3(surah)}/${pad3(surah)}_${pad3(ayah)}.json`

// Inline mushaf-style ayah markers: ﴿٣﴾ after the Arabic, (۳)/(3) after the meaning.
const toArabicDigits = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d])
const toFaDigits = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d])
const meaningMarker = (n, lang) => (lang === 'fa' ? `(${toFaDigits(n)})` : lang === 'ar' ? `(${toArabicDigits(n)})` : `(${n})`)

// The meaning text for a language L, straight from the surah data JSON.
function meaningOf(a, lang) {
  if (lang === 'fa') return a.fa
  if (lang === 'en') return a.en
  return a.t?.[lang] || ''
}

// Translators add clarifying words in [..] or (..) that aren't literally in the
// Arabic. When the reader is set to NOT read insertions, strip those runs so the
// shown text matches the `.noann` audio: remove the bracketed runs, then tidy the
// spacing left before punctuation and any double spaces.
function meaningForDisplay(text, keepAnn) {
  if (keepAnn) return text
  return String(text || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+([،.!؟:;.])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// When insertions ARE shown, keep the brackets visible but wrap each [..]/(..)
// run in <span class="jq-ann"> so it reads in a subtly muted colour.
function renderMeaning(text) {
  const parts = String(text || '').split(/(\[[^\]]*\]|\([^)]*\))/g)
  return parts.map((p, i) =>
    /^\[[^\]]*\]$/.test(p) || /^\([^)]*\)$/.test(p)
      ? <span key={i} className="jq-ann">{p}</span>
      : p,
  )
}

export default function Reader() {
  const { t } = useI18n()
  const { num, ayah: ayahParam } = useParams()
  const surahNum = Number(num)
  // Single-ayah EMBED mode: the /ayah/:num/:ayah route renders just that one
  // ayah with the full player (the shareable unit mounted inside a Social post).
  const focusAyah = ayahParam != null && ayahParam !== '' ? Number(ayahParam) : null
  const embed = focusAyah != null
  const [surah, setSurah] = useState(null)
  const [error, setError] = useState(null)

  // Dedicated tafsir (Bazargan) — needed for the lecture TTS id and for the
  // tafsir transcript text shown under each ayah. Two variants: the LONG lecture
  // and the SHORT summary. Both play AI-TTS of their transcript (the human
  // recordings are only the STT source and are NEVER played, in any language).
  const [tafsir, setTafsir] = useState(null)
  const [tafsirShort, setTafsirShort] = useState(null)

  // Reader settings (single meaning language + two toggles). Live-updates while
  // the Settings drawer is open via the settings event.
  const [settings, setSettings] = useState(getReaderSettings)
  const { meaningLang, reciteArabic, tafsirMode, readAnnotations } = settings
  const settingsRef = useRef(settings)
  useEffect(() => { settingsRef.current = settings }, [settings])
  useEffect(() => {
    const h = (e) => setSettings(e.detail)
    window.addEventListener(READER_SETTINGS_EVENT, h)
    return () => window.removeEventListener(READER_SETTINGS_EVENT, h)
  }, [])
  const mDir = dirOf(meaningLang)

  // Embed controls: viewers pick the reciter (recitation voice) right on the
  // shared card. `reciter` mirrors the persisted choice so the <select> tracks
  // it; the next recitation resolves the newly chosen voice.
  const [reciters, setReciters] = useState([])
  const [reciter, setReciterLocal] = useState(getReciter)
  useEffect(() => {
    if (!embed) return
    loadReciters().then(setReciters).catch(() => {})
  }, [embed])

  // Embed auto-height: report the natural content height to the host (yQuran feed)
  // so the post card sizes to its content — small for a bare ayah, taller as the
  // tafsir grows — instead of a fixed frame with dead space. The host clamps it to
  // a fraction of the screen and scrolls inside past that. Re-reports on any
  // reflow (settings change, tafsir text arriving, font/lang swap).
  useEffect(() => {
    if (!embed || typeof window === 'undefined' || window.parent === window) return
    let raf = 0
    const post = () => {
      raf = 0
      const h = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0,
      )
      if (h > 0) window.parent.postMessage({ type: 'joow:embed-height', height: h }, '*')
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(post) }
    schedule()
    const ro = new ResizeObserver(schedule)
    if (document.body) ro.observe(document.body)
    window.addEventListener('resize', schedule)
    window.addEventListener('load', schedule)
    const t = setTimeout(schedule, 400) // catch async tafsir text / fonts settling
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('load', schedule)
      if (raf) cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [embed])

  // Tafsir transcript text keyed `${mode}:${lang}:${ayah}` -> { text } | { error } | { note }.
  // `mode` (long|short) is in the key so switching Tafsir mode shows the right transcript.
  const [tafsirText, setTafsirText] = useState({})
  const txOf = (n) => tafsirText[`${tafsirMode}:${meaningLang}:${n}`]
  const inflight = useRef(new Set())

  // Comments: counts per ayah (0 = surah-level); which thread is open.
  const [commentCounts, setCommentCounts] = useState({})
  const [openComments, setOpenComments] = useState(null)
  const [shareNote, setShareNote] = useState(null) // transient "shared / copied" toast

  // ---- Playback state ----
  // cursor = { n, si, kind } — the ayah + step currently being read (null = idle).
  const [cursor, setCursor] = useState(null)
  const cursorRef = useRef(null)
  const [busy, setBusy] = useState(false)       // a clip is loading
  const [note, setNote] = useState(null)        // honest "being prepared" note
  const [playErr, setPlayErr] = useState(null)  // { n, si, msg } genuine (non-503) load error
  const [paused, setPaused] = useState(false)
  const audioRef = useRef(null)
  // Every fresh start/stop bumps this token; stale async resolves are dropped.
  const runIdRef = useRef(0)

  // Word timings for the CURRENT step: { words:[{w,s,e}], dur } | null (null =>
  // no sidecar => whole-line highlight). `activeUrlRef` pins the URL the timings
  // belong to so a late sidecar fetch for a step we've already left is ignored.
  const [activeWords, setActiveWords] = useState(null)
  const activeUrlRef = useRef(null)
  // The language of the clip that is ACTUALLY loaded/playing. During a live
  // language switch the settings language changes immediately but the old clip
  // keeps playing until the new one resolves — the player label and the karaoke
  // text direction must follow THIS, not the settings, or English words render
  // right-to-left under a "Persian" label for the transition window.
  const [activeLang, setActiveLang] = useState(null)

  // Playback speed (persisted). Speed is applied as SILENCE EDITING, never as a
  // rate change on the speech: when the clip has word timings (karaoke sidecar)
  // we keep playbackRate at 1 and the rAF tick trims/stretches the known gaps
  // (see lib/gapSpeed.js) — the voice's tone and delivery are untouched. Only a
  // clip with NO sidecar falls back to playbackRate (pitch-preserved).
  const [speed, setSpeed] = useState(() => {
    const v = Number(localStorage.getItem('jq.speed'))
    return v === 0.75 || v === 1.5 ? v : 1 // three steps: slow / normal / fast
  })
  const speedRef = useRef(speed)
  // Apply the right mechanism for the current clip: sidecar known-absent ->
  // legacy rate (with pitch preserved); sidecar present or still loading ->
  // a ≤10% imperceptible rate nudge (gap editing does the rest of the speed).
  // Safe to call at any time.
  const applySpeed = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    try { el.preservesPitch = true; el.webkitPreservesPitch = true } catch { /* older engines */ }
    el.playbackRate = syncRef.current.sidecarNone ? speedRef.current : speechRate(speedRef.current)
  }, [])
  // Stable handle for effects that must not add deps (the live-swap effect).
  const applySpeedRef = useRef(applySpeed)
  useEffect(() => { applySpeedRef.current = applySpeed }, [applySpeed])
  useEffect(() => {
    speedRef.current = speed
    localStorage.setItem('jq.speed', String(speed))
    applySpeed()
  }, [speed, applySpeed])
  const cycleSpeed = useCallback(() => {
    const S = [1, 1.5, 0.75] // normal -> fast -> slow -> normal
    setSpeed((cur) => S[(S.indexOf(cur) + 1) % S.length])
  }, [])

  // ---- Read-along sync engine ----
  // activeBlockRef = the DOM node of the block being read (Arabic / meaning /
  // tafsir). autoScrollRef gates the stable-zone auto-scroll; a hand-scroll turns
  // it off, play / a word-tap turn it back on. syncRef holds imperative,
  // non-React state driven by a single rAF loop (word highlight + smooth scroll).
  const activeBlockRef = useRef(null)
  const autoScrollRef = useRef(true)
  // gaps/gapMeta/stretched/pendingSeeks/sidecarNone drive the gap-based speed
  // engine (lib/gapSpeed.js): known silence windows, the speech/silence budget,
  // which gaps this pass has already lengthened, the TARGETS of engine seeks
  // still awaiting their `seeked` (so onSeeked can tell our seeks from a user's
  // by position), and whether the clip has no word sidecar (-> rate fallback).
  const syncRef = useRef({ els: [], timings: [], lastIdx: -1, raf: 0, curY: 0, hasWords: false, gaps: [], gapMeta: null, stretched: new Set(), pendingSeeks: [], sidecarNone: false })
  // Mirror of autoScrollRef for the UI (the player's follow button lights up
  // while the user has scrolled away). setFollow keeps ref + state in sync.
  const [following, setFollowing] = useState(true)
  const setFollow = useCallback((v) => { autoScrollRef.current = v; setFollowing(v) }, [])
  // Re-arm the follow a few seconds after the LAST hand gesture (the video-
  // review ask: "if I scroll and don't touch for a couple of seconds, resume").
  const followResumeRef = useRef(0)
  // The shared-ayah embed is a focused "watch this ayah" card — re-follow quickly
  // after an incidental feed-scroll over it. The full reader is a long document you
  // browse, so it waits longer before yanking back to the playhead.
  const FOLLOW_RESUME_MS = embed ? 2500 : 7000
  const reduceMotionRef = useRef(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => { reduceMotionRef.current = mq.matches }
    apply()
    mq.addEventListener?.('change', apply)
    return () => mq.removeEventListener?.('change', apply)
  }, [])

  // Scroll so `el` sits at ~35% down the viewport (the "stable zone"), clamped to
  // the document bounds.
  const targetYFor = useCallback((el) => {
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const absTop = rect.top + window.scrollY
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    return Math.max(0, Math.min(maxY, absTop - window.innerHeight * 0.35))
  }, [])

  // Last word whose start <= t (so a word stays lit through the gap until the next
  // begins — smoother than a strict s<=t<e window). -1 before the first word.
  const idxAt = useCallback((t) => {
    const T = syncRef.current.timings
    let lo = 0, hi = T.length - 1, ans = -1
    while (lo <= hi) { const m = (lo + hi) >> 1; if (T[m].s <= t) { ans = m; lo = m + 1 } else hi = m - 1 }
    return ans
  }, [])

  // Move the karaoke highlight to word `idx` by touching only the DOM (no React).
  // Words before it dim (.jq-read); the active one is strong (.jq-kw).
  const paintWord = useCallback((idx) => {
    const s = syncRef.current
    if (idx === s.lastIdx) return
    const els = s.els
    for (let i = 0; i < els.length; i++) {
      const c = els[i].classList
      if (i === idx) { c.add('jq-kw'); c.remove('jq-read') }
      else if (i < idx) { c.add('jq-read'); c.remove('jq-kw') }
      else { c.remove('jq-kw'); c.remove('jq-read') }
    }
    s.lastIdx = idx
  }, [])

  // One frame: advance the highlight and lerp the scroll toward the active word
  // (or the whole block when there are no word timings).
  const tick = useCallback(() => {
    const el = audioRef.current
    const s = syncRef.current
    if (!el) { s.raf = 0; return }
    // Accumulate ACTUALLY-HEARD seconds from the rAF loop (proven to run while
    // playing — it drives the karaoke). This is far more reliable than the
    // audio `timeupdate` event, which some browsers throttle heavily inside a
    // cross-origin iframe (the embedded-in-yQuran case). Only small forward
    // deltas count, so clip changes (currentTime resets to ~0) and seeks are
    // naturally skipped.
    if (!el.paused) {
      const dt = el.currentTime - (s.heardT ?? el.currentTime)
      if (dt > 0 && dt < 2) activity.addHeard(dt, el.duration)
      s.heardT = el.currentTime
    }
    // Gap-based speed: trim (fast) or replay (slow) known silences by seeking.
    // The speech itself always plays at 1.0x. Re-baseline heardT after our own
    // seek so the skipped/replayed silence never counts as heard time.
    {
      const moved = gapTick(el, s, speedRef.current)
      if (moved != null) s.heardT = moved
    }
    if (s.hasWords) paintWord(idxAt(el.currentTime))
    if (autoScrollRef.current) {
      const anchor = (s.hasWords && s.lastIdx >= 0 && s.els[s.lastIdx]) ? s.els[s.lastIdx] : activeBlockRef.current
      const y = targetYFor(anchor)
      if (y != null) {
        if (reduceMotionRef.current) { window.scrollTo(0, y) }
        else {
          s.curY += (y - s.curY) * 0.16
          if (Math.abs(y - s.curY) < 0.6) s.curY = y
          window.scrollTo(0, s.curY)
        }
      }
    }
    if (!el.paused) s.raf = requestAnimationFrame(tick)
    else s.raf = 0
  }, [idxAt, paintWord, targetYFor])

  const startLoop = useCallback(() => {
    const s = syncRef.current
    if (s.raf) return
    s.curY = window.scrollY
    // Baseline heard-seconds accounting to NOW so the first frame's delta is ~0
    // (covers play, resume-after-pause, and each step's fresh clip).
    s.heardT = audioRef.current ? audioRef.current.currentTime : 0
    s.raf = requestAnimationFrame(tick)
  }, [tick])
  const stopLoop = useCallback(() => {
    const s = syncRef.current
    if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0 }
  }, [])

  useEffect(() => { getDedicatedTafsir().then((tf) => setTafsir((cur) => cur || tf)) }, [])
  useEffect(() => { getDedicatedShortTafsir().then((tf) => setTafsirShort((cur) => cur || tf)) }, [])
  // The tafsir source for the current mode: SHORT summary vs LONG lecture.
  const activeTafsir = tafsirMode === 'short' ? tafsirShort : tafsir

  useEffect(() => {
    runIdRef.current++
    setSurah(null); setCursor(null); cursorRef.current = null
    setBusy(false); setNote(null); setPlayErr(null); setPaused(false)
    setTafsirText({}); setOpenComments(null)
    loadSurah(surahNum)
      .then((s) => { setSurah(s); localStorage.setItem('jq.lastRead', JSON.stringify({ surah: surahNum, nameFa: s.nameFa })) })
      .catch((e) => setError(String(e)))
    fetchCommentCounts(surahNum).then(setCommentCounts).catch(() => setCommentCounts({}))
    window.scrollTo(0, 0)
    activity.readEnter(surahNum)
    return () => activity.readLeave()
  }, [surahNum])

  // ---- Tafsir transcript text (only when Tafsir is Short/Long) ----
  // One text per ayah in the meaning language: local cache -> server get-or-create.
  // 503/errors degrade to an honest note; they never block reading or playback.
  const fetchTafsirText = useCallback(async (n) => {
    const taf = activeTafsir
    if (!taf) return
    const k = `${tafsirMode}:${meaningLang}:${n}`
    if (inflight.current.has(k)) return
    const cached = getCached(taf.id, meaningLang, surahNum, n)
    if (cached) { setTafsirText((m) => (m[k] ? m : { ...m, [k]: cached })); return }
    inflight.current.add(k)
    try {
      const r = await getServerTranscript(taf, surahNum, n, meaningLang)
      const e = { text: r.text, source: r.source }
      setCached(taf.id, meaningLang, surahNum, n, e)
      setTafsirText((m) => ({ ...m, [k]: e }))
    } catch (err) {
      // In Farsi "Original" mode the recording plays even without a transcript —
      // so the honest note is the reverse of the default (audio works, text is
      // still being prepared), not "audio arrives soon".
      const note = t(meaningLang === 'fa' ? 'originalNoText' : 'ttsUnavailable')
      setTafsirText((m) => ({ ...m, [k]: err?.status === 503 ? { note } : { error: String(err.message || err) } }))
    }
    inflight.current.delete(k)
  }, [activeTafsir, tafsirMode, meaningLang, surahNum, t])

  useEffect(() => {
    // Both LONG and SHORT tafsir have a transcript (short summary is STT'd too),
    // so fetch the on-screen text whenever Tafsir is enabled.
    if (!activeTafsir || !surah || (tafsirMode !== 'long' && tafsirMode !== 'short')) return
    for (const a of surah.ayahs) fetchTafsirText(a.n)
  }, [activeTafsir, surah, tafsirMode, meaningLang, fetchTafsirText])

  // ---- Step queue ----
  // The kinds played for every ayah, in order, from the current settings.
  const stepKinds = useCallback(() => {
    const s = settingsRef.current
    const ks = []
    if (s.reciteArabic) ks.push('recite')
    ks.push('meaning')
    if (s.tafsirMode === 'long' || s.tafsirMode === 'short') ks.push('tafsir')
    return ks
  }, [])

  // Resolve one step to a playable URL. recite is direct; meaning + tafsir go
  // through the 503-tolerant backend (get-or-create AI TTS with a word-timing
  // sidecar). Tafsir — long OR short — normally plays AI TTS of the transcript,
  // in EVERY language including Persian.
  //
  // EXCEPTION — Farsi "Original" mode: play Abdolali Bazargan's OWN recording
  // instead of the AI narration. These human recordings cover the WHOLE Qur'an
  // (the AI narration only exists for a few surahs), so this is what lets Farsi
  // users open any surah today. Word-karaoke appears only where a .words.json
  // sidecar has been generated from the STT transcript; otherwise the reader
  // falls back to whole-line highlighting.
  const resolveUrl = useCallback(async (kind, n) => {
    const s = settingsRef.current
    if (kind === 'recite') return recitationAudioUrl(surahNum, n)
    if (kind === 'meaning') return getMeaningUrl(surahNum, n, s.meaningLang, s.readAnnotations)
    // Farsi ALWAYS plays Abdolali Bazargan's own recording (owner: "whenever it
    // is Farsi, since we have all the audio from Bazargan, play the original").
    // His human recordings cover the WHOLE Qur'an; the AI narration only exists
    // for a few surahs — so for Persian this is both the intended voice and the
    // only path with full coverage. No opt-in flag: Persian ⇒ Bazargan.
    if (s.meaningLang === 'fa') {
      return s.tafsirMode === 'short' ? shortTafsirAudioUrl(surahNum, n) : tafsirAudioUrl(surahNum, n)
    }
    // tafsir (long lecture or short summary) — one unified AI-TTS pipeline.
    const taf = s.tafsirMode === 'short' ? tafsirShort : tafsir
    if (!taf) { const e = new Error('tafsir not ready'); e.status = 503; throw e }
    return getTtsUrl(taf, surahNum, n, s.meaningLang)
  }, [surahNum, tafsir, tafsirShort])

  const stop = useCallback(() => {
    runIdRef.current++
    stopLoop()
    const el = audioRef.current
    if (el) { el.pause(); el.removeAttribute('src') }
    setCursor(null); cursorRef.current = null
    setBusy(false); setNote(null); setPaused(false)
    setActiveWords(null); activeUrlRef.current = null
    setActiveLang(null)
    activity.finalizeStep(false)
    activity.flush()
  }, [stopLoop])

  // Play step `si` of ayah `n`; drives the whole surah by advancing itself.
  const playStep = useCallback(async (n, si) => {
    const el = audioRef.current
    if (!el || !surah) return
    if (n > surah.ayahs.length) { stop(); return } // reached the end -> clean stop
    if (embed && focusAyah != null && n > focusAyah) { stop(); return } // embed = ONE ayah only
    const kinds = stepKinds()
    if (si >= kinds.length) { playStep(n + 1, 0); return } // this ayah done -> next ayah
    const kind = kinds[si]
    const myRun = runIdRef.current
    const c = { n, si, kind }
    setCursor(c); cursorRef.current = c
    setBusy(true); setNote(null)
    try {
      const url = await resolveUrl(kind, n)
      if (myRun !== runIdRef.current) return // cancelled while resolving
      el.src = url
      // Fresh clip: assume a sidecar until the fetch below says otherwise, so
      // the speech starts at its natural rate (gap editing will do the speed).
      { const s = syncRef.current; s.sidecarNone = false; s.gaps = []; s.gapMeta = null; s.stretched = new Set(); s.pendingSeeks = [] }
      applySpeed()
      {
        const st = settingsRef.current
        activity.stepStarted({
          surah: surahNum, ayah: n, kind,
          lang: kind === 'recite' ? 'ar' : st.meaningLang,
          mode: kind === 'tafsir' ? st.tafsirMode : null,
          reciter: kind === 'recite' ? getReciter() : null,
          speed: speedRef.current,
        })
      }
      // Fetch this clip's word-timing sidecar (cached per URL). `activeUrlRef`
      // pins the current step's URL so a late/stale sidecar is discarded and we
      // fall back to a whole-line highlight (null) until the right one lands.
      activeUrlRef.current = url
      setActiveWords(null)
      setActiveLang(kind === 'recite' ? 'ar' : settingsRef.current.meaningLang)
      // Recitation timings live in their own tree (community data keyed by
      // reciter); TTS clips carry their sidecar next to the mp3.
      loadWords(url, kind === 'recite' ? recitationWordsUrl(surahNum, n) : undefined)
        .then((w) => {
          if (activeUrlRef.current !== url) return
          setActiveWords(w)
          // No sidecar -> this clip's speed falls back to (pitch-preserved) rate.
          syncRef.current.sidecarNone = !w
          applySpeed()
        })
      await el.play()
      if (myRun !== runIdRef.current) { el.pause(); return }
      setBusy(false)
    } catch (err) {
      if (myRun !== runIdRef.current) return // cancelled — swallow the abort
      setBusy(false)
      if (err?.status === 503) {
        // Not synthesized yet: honest note, skip this step, keep reading.
        setNote(t('ttsUnavailable'))
        playStep(n, nextSiAfterRef.current(kind))
      } else {
        // Genuine fetch/playback failure: pause the chain, offer a Retry.
        console.warn('[reader] step failed', { n, si, kind, err: String(err?.message || err) })
        setPlayErr({ n, si, msg: t('audioLoadError') })
      }
    }
  }, [surah, stepKinds, resolveUrl, stop, t, applySpeed, embed, focusAyah])

  // onEnded must call the LATEST playStep closure (settings may have changed).
  const playStepRef = useRef(playStep)
  useEffect(() => { playStepRef.current = playStep }, [playStep])

  // ---- "Magic" live settings switch ----
  // Changing the meaning language (or the tafsir length, or the [..] insertions
  // toggle) while something is playing swaps the CURRENT step's audio to the new
  // setting's clip IN PLACE: same ayah, same step, proportional position, playing
  // state preserved. The old clip keeps playing until the new one has resolved,
  // so the switch feels instant — never a stop/restart. Arabic recitation is
  // unaffected by the meaning language, so a 'recite' step never swaps.
  const resolveUrlRef = useRef(resolveUrl)
  useEffect(() => { resolveUrlRef.current = resolveUrl }, [resolveUrl])
  const swapIdRef = useRef(0)
  const prevSwapKeyRef = useRef(`${meaningLang}|${tafsirMode}|${readAnnotations}`)
  useEffect(() => {
    const key = `${meaningLang}|${tafsirMode}|${readAnnotations}`
    const prev = prevSwapKeyRef.current
    if (prev === key) return
    const [pLang, pMode, pAnn] = prev.split('|')
    prevSwapKeyRef.current = key
    const langChanged = pLang !== meaningLang
    const modeChanged = pMode !== tafsirMode
    const annChanged = pAnn !== String(readAnnotations)
    const c = cursorRef.current
    const el = audioRef.current
    if (!c || !el || !el.src) return
    if (c.kind === 'recite') return
    if (c.kind === 'meaning' && !(langChanged || annChanged)) return
    if (c.kind === 'tafsir' && !(langChanged || modeChanged)) return
    // Tafsir switched OFF while a tafsir step is playing -> glide to the next ayah.
    // Pause first so the old clip can't fire onEnded and double-advance.
    if (c.kind === 'tafsir' && tafsirMode !== 'long' && tafsirMode !== 'short') {
      el.pause()
      playStepRef.current(c.n + 1, 0)
      return
    }
    // Take over the run: killing the runId cancels any playStep still awaiting
    // resolveUrl (otherwise its late resolve would race this swap for el.src and
    // could put the OLD language back).
    const myRun = ++runIdRef.current
    const mySwap = ++swapIdRef.current
    const wasPaused = el.paused
    // If the old clip already ENDED, its onEnded/playStep chain was just killed by
    // the runId bump — start the new clip from 0 instead of seeking to ~100% (which
    // would instantly end it and silently skip the step). Cap at 0.95 for safety.
    const frac = el.ended ? 0
      : isFinite(el.duration) && el.duration > 0 ? Math.min(el.currentTime / el.duration, 0.95) : 0
    setBusy(true)
    const oldUrl = el.src
    const oldTime = el.currentTime
    ;(async () => {
      try {
        const url = await resolveUrlRef.current(c.kind, c.n)
        if (myRun !== runIdRef.current || mySwap !== swapIdRef.current || cursorRef.current !== c) {
          // Superseded by a newer swap/step — that path owns `busy` now.
          if (mySwap === swapIdRef.current) setBusy(false)
          return
        }
        // Sentence-accurate landing (v2 §C): same tafsir, new language -> map the
        // sentence being spoken through the cross-language anchor units. Any
        // missing piece (anchors not built, segments absent) -> proportional.
        let seekSec = null
        if (c.kind === 'tafsir' && langChanged && !modeChanged && !el.ended) {
          const taf = tafsirMode === 'short' ? tafsirShort : tafsir
          if (taf) {
            seekSec = await anchorSeekTarget(
              oldUrl, oldTime, pLang, url, meaningLang,
              tafsirAnchorsUrl(taf.id, surahNum, c.n)
            )
            if (myRun !== runIdRef.current || mySwap !== swapIdRef.current) return
          }
        }
        activeUrlRef.current = url
        setActiveWords(null)
        setActiveLang(settingsRef.current.meaningLang)
        loadWords(url).then((w) => {
          if (activeUrlRef.current !== url) return
          setActiveWords(w)
          syncRef.current.sidecarNone = !w
          applySpeedRef.current()
        })
        el.src = url
        { const s = syncRef.current; s.sidecarNone = false; s.gaps = []; s.gapMeta = null; s.stretched = new Set(); s.pendingSeeks = [] }
        applySpeedRef.current()
        {
          const st = settingsRef.current
          activity.stepStarted({
            surah: surahNum, ayah: c.n, kind: c.kind,
            lang: c.kind === 'recite' ? 'ar' : st.meaningLang,
            mode: c.kind === 'tafsir' ? st.tafsirMode : null,
            reciter: c.kind === 'recite' ? getReciter() : null,
            speed: speedRef.current,
          })
        }
        // Keep the listener's PLACE: seek the new clip once its duration is known
        // — to the anchored sentence when available, else the same fraction. The
        // guard re-checks run/swap/cursor because with preload="none" a paused
        // swap's metadata can arrive much later — or the listener could otherwise
        // fire against a DIFFERENT clip loaded after this one.
        el.addEventListener('loadedmetadata', function onMeta() {
          el.removeEventListener('loadedmetadata', onMeta)
          if (myRun !== runIdRef.current || mySwap !== swapIdRef.current || cursorRef.current !== c) return
          if (!isFinite(el.duration) || el.duration <= 0) return
          if (seekSec != null && seekSec < el.duration) el.currentTime = seekSec
          else if (frac > 0) el.currentTime = frac * el.duration
        })
        if (wasPaused) {
          // preload="none" would never fetch metadata for a paused element — force
          // it so the scrubber/karaoke show the preserved position immediately.
          el.preload = 'metadata'
          el.load()
        } else {
          await el.play()
        }
        if (myRun !== runIdRef.current || mySwap !== swapIdRef.current) return
        setBusy(false); setNote(null)
      } catch (err) {
        if (myRun !== runIdRef.current || mySwap !== swapIdRef.current) return
        setBusy(false)
        if (err?.status === 503) {
          // New language's clip isn't synthesized yet: honest note, move on.
          // Pause first so the old clip can't fire onEnded and double-advance.
          el.pause()
          setNote(t('ttsUnavailable'))
          playStepRef.current(c.n, nextSiAfterRef.current(c.kind))
        } else {
          console.warn('[reader] live swap failed', { n: c.n, kind: c.kind, err: String(err?.message || err) })
          setPlayErr({ n: c.n, si: c.si, msg: t('audioLoadError') })
        }
      }
    })()
  }, [meaningLang, tafsirMode, readAnnotations, t])

  // Advance by KIND, not by raw index: settings toggles (e.g. "Recite Arabic
  // first") can change the step list mid-ayah, so "si + 1" against a freshly
  // recomputed list would replay or skip a step. The canonical order is
  // recite -> meaning -> tafsir; the next step is the first kind AFTER the
  // current one that exists in the CURRENT settings' list.
  const STEP_ORDER = ['recite', 'meaning', 'tafsir']
  const nextSiAfter = useCallback((kind) => {
    const kinds = stepKinds()
    for (let i = STEP_ORDER.indexOf(kind) + 1; i < STEP_ORDER.length; i++) {
      const j = kinds.indexOf(STEP_ORDER[i])
      if (j !== -1) return j
    }
    return kinds.length // past the end -> playStep advances to the next ayah
  }, [stepKinds])
  const nextSiAfterRef = useRef(nextSiAfter)
  useEffect(() => { nextSiAfterRef.current = nextSiAfter }, [nextSiAfter])

  const onEnded = useCallback(() => {
    activity.stepEnded()
    const c = cursorRef.current
    if (!c) return
    playStepRef.current(c.n, nextSiAfterRef.current(c.kind))
  }, [])

  // Start (or restart) the read-along from a given ayah. Any explicit start
  // re-arms the stable-zone auto-scroll (the user asked to be carried along).
  const startAt = useCallback((n) => {
    runIdRef.current++
    setFollow(true)
    setPlayErr(null); setNote(null); setPaused(false)
    playStepRef.current(n, 0)
  }, [])

  // Player follow button: re-arm the karaoke follow and land on the reading
  // immediately (while playing the rAF loop glides; while paused do a one-shot).
  const recenter = useCallback(() => {
    clearTimeout(followResumeRef.current)
    setFollow(true)
    const el = audioRef.current
    const s = syncRef.current
    const anchorEl = (s.hasWords && s.lastIdx >= 0 && s.els[s.lastIdx]) ? s.els[s.lastIdx] : activeBlockRef.current
    if (el && el.paused && anchorEl) {
      const y = targetYFor(anchorEl)
      if (y != null) { window.scrollTo({ top: y, behavior: reduceMotionRef.current ? 'auto' : 'smooth' }); s.curY = y }
    }
  }, [setFollow, targetYFor])

  // Header control: start the whole surah, or stop.
  const toggleSurah = useCallback(() => { if (cursor) stop(); else startAt(1) }, [cursor, stop, startAt])

  // Mini-player: pause / resume the current clip (does not leave the session).
  const togglePause = useCallback(() => {
    const el = audioRef.current
    if (!el || !el.src) return
    if (el.paused) { setFollow(true); el.play().catch(() => {}) } else el.pause()
  }, [])

  // Snap the page so the CURRENTLY-highlighted word (or the whole block, when a
  // clip has no word timings) sits in the stable zone — instantly, no lerp. Used
  // while scrubbing so the reading tracks the playhead exactly, even when paused.
  const scrollToActiveWord = useCallback(() => {
    const s = syncRef.current
    const anchor = (s.hasWords && s.lastIdx >= 0 && s.els[s.lastIdx]) ? s.els[s.lastIdx] : activeBlockRef.current
    const y = targetYFor(anchor)
    if (y != null) { s.curY = y; window.scrollTo(0, y) }
  }, [targetYFor])
  // A user-driven seek (scrubber / ±10s / word-tap) is an explicit "take me
  // here": re-arm follow and carry the karaoke + scroll to the playhead.
  const followPlayhead = useCallback(() => { setFollow(true); scrollToActiveWord() }, [setFollow, scrollToActiveWord])
  // Carry the reader to a target TIME immediately — highlight the word at `time`
  // and scroll to it — driven by the scrub value itself, NOT the audio's `seeked`
  // event. That keeps the karaoke + scroll glued to the slider even while the
  // audio is still fetching an unbuffered position (and even while paused).
  const carryTo = useCallback((time) => {
    if (!isFinite(time)) return
    setFollow(true)
    const s = syncRef.current
    if (s.hasWords) paintWord(idxAt(time))
    scrollToActiveWord()
  }, [setFollow, paintWord, idxAt, scrollToActiveWord])

  // Two-way sync: tapping a word seeks the current clip to that word's start and
  // re-arms auto-scroll (resuming playback if we were paused).
  const seekToWord = useCallback((s) => {
    const el = audioRef.current
    if (!el || !isFinite(s)) return
    el.currentTime = s
    carryTo(s)
    if (el.paused) el.play().catch(() => {})
  }, [carryTo])

  // Player transport: nudge the current clip by ±seconds (clamped).
  const seekBy = useCallback((delta) => {
    const el = audioRef.current
    if (!el || !el.src) return
    const d = isFinite(el.duration) ? el.duration : Infinity
    el.currentTime = Math.max(0, Math.min(d - 0.05, el.currentTime + delta))
    carryTo(el.currentTime)
  }, [carryTo])
  // The scrubber drives this on every drag movement: move the karaoke + scroll to
  // the dragged-to time instantly (independent of audio buffering).
  const onScrub = useCallback((time) => carryTo(time), [carryTo])

  // Player transport: previous / next AYAH — restart the read-along at that ayah
  // with the current settings (recite→meaning→tafsir from step 0).
  const prevAyah = useCallback(() => {
    const c = cursorRef.current
    if (!c) return
    startAt(Math.max(1, c.n - 1))
  }, [startAt])
  const nextAyah = useCallback(() => {
    const c = cursorRef.current
    if (!c || !surah) return
    if (c.n < surah.ayahs.length) startAt(c.n + 1)
  }, [startAt, surah])

  // Retry a genuinely-failed step from exactly where it dropped.
  const retry = useCallback(() => {
    if (!playErr) return
    const { n, si } = playErr
    setPlayErr(null)
    runIdRef.current++
    playStepRef.current(n, si)
  }, [playErr])

  // Share ONE ayah as an interactive post (framed → yQuran; standalone → link).
  const doShareAyah = useCallback(async (n) => {
    const res = await shareAyah(surahNum, n, {
      lang: meaningLang,
      surahName: surah?.nameEn || surah?.nameFa,
      ayahLabel: t('ayah'), playLabel: t('shareAyah'),
    })
    const msg = res === 'shared-to-yquran' ? (t('sharedToYquran') || 'Shared to yQuran')
      : res === 'copied' ? (t('linkCopied') || 'Link copied')
      : res === 'shared' ? (t('shared') || 'Shared')
      : (t('shareFailed') || 'Could not share')
    setShareNote(msg)
    clearTimeout(doShareAyah._t)
    doShareAyah._t = setTimeout(() => setShareNote(null), 2400)
  }, [surahNum, meaningLang, t, surah])

  // A hand gesture (wheel / touch-drag / scroll key) means "let me look around" —
  // suspend the stable-zone auto-scroll. Play, a word-tap or a transport action
  // re-arm it. These fire ONLY on real user input, never on our programmatic
  // window.scrollTo, so there's no feedback loop to debounce.
  useEffect(() => {
    const off = (e) => {
      // Interacting with the transport bar (dragging the scrubber, tapping ±10s)
      // is an explicit "move me here", NOT a browse-away gesture — it must never
      // disable follow, or the screen would stop tracking the scrub.
      if (e && e.target && e.target.closest && e.target.closest('.jq-player')) return
      setFollow(false)
      // Idle-resume: a few quiet seconds after the LAST gesture, glide back to
      // the reading — but only while a clip is actually playing (play itself
      // re-arms the follow anyway when paused).
      clearTimeout(followResumeRef.current)
      followResumeRef.current = setTimeout(() => {
        const el = audioRef.current
        if (el && !el.paused && cursorRef.current) setFollow(true)
      }, FOLLOW_RESUME_MS)
    }
    const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'])
    const onKey = (e) => { if (scrollKeys.has(e.key)) off(e) }
    window.addEventListener('wheel', off, { passive: true })
    window.addEventListener('touchmove', off, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(followResumeRef.current)
      window.removeEventListener('wheel', off)
      window.removeEventListener('touchmove', off)
      window.removeEventListener('keydown', onKey)
    }
  }, [setFollow])

  // Drive the rAF sync loop from the shared audio element: play starts it (and
  // re-arms auto-scroll); while paused, `seeked`/`timeupdate` still repaint the
  // highlight so scrubbing lands the reader on the right word.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onPlay = () => { setFollow(true); startLoop() }
    // Heard-seconds accounting lives in the rAF `tick` loop (reliable inside the
    // embedded iframe); a seek just re-baselines it so the jump isn't counted.
    const onSeeked = () => {
      const s = syncRef.current
      const cur = el.currentTime
      s.heardT = cur
      // Attribute this `seeked` by position. If it matches the oldest pending
      // engine-seek target, it's ours — consume it. Otherwise it's a genuine
      // USER seek (scrub, ±5s, word-tap): drop stale engine targets and re-arm
      // slow-mode stretches for gaps AT/AFTER the landing so a replayed passage
      // paces the same way again (gaps already behind us stay consumed).
      const pi = s.pendingSeeks.findIndex((to) => Math.abs(cur - to) < 0.25)
      if (pi !== -1) {
        // Our own engine seek (gap trim/replay): just repaint, don't touch follow.
        s.pendingSeeks.splice(0, pi + 1)
        if (s.hasWords) paintWord(idxAt(cur))
        if (el.paused) tick()
        return
      }
      // A genuine USER seek (scrubber / ±10s / word-tap): re-arm slow-mode
      // stretches from here, then CARRY the reader to the playhead — highlight
      // the word and scroll to it, whether playing or paused.
      s.pendingSeeks.length = 0
      for (const gi of [...s.stretched]) { const g = s.gaps[gi]; if (g && g.e >= cur - 0.05) s.stretched.delete(gi) }
      if (s.hasWords) paintWord(idxAt(cur))
      followPlayhead()
    }
    const onTime = () => {
      const s = syncRef.current
      // While paused (e.g. mid-scrub), keep the highlight and scroll on the
      // playhead too — some browsers fire `timeupdate` more often than `seeked`.
      if (el.paused && s.hasWords) { paintWord(idxAt(el.currentTime)); if (autoScrollRef.current) scrollToActiveWord() }
    }
    el.addEventListener('play', onPlay)
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('timeupdate', onTime)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('timeupdate', onTime)
      stopLoop()
    }
  }, [startLoop, stopLoop, paintWord, idxAt, tick, setFollow, followPlayhead, scrollToActiveWord])

  // Backgrounding throttles/freezes rAF and (on some platforms) pauses the
  // audio; coming back could leave a dead loop, a stale scroll baseline and a
  // stale highlight. On every return to the foreground: repaint the word for
  // the CURRENT audio time, snap the lerp baseline to the real scroll position
  // (no jump-glide from a stale origin), and make sure the loop is running.
  useEffect(() => {
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      const el = audioRef.current
      const s = syncRef.current
      if (!el || !cursorRef.current) return
      s.curY = window.scrollY
      if (s.hasWords) paintWord(idxAt(el.currentTime))
      if (!el.paused) startLoop()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [paintWord, idxAt, startLoop])

  // Karaoke stability watchdog (owner: "when the voice is playing, always check the
  // karaoke too — make it more stable"). The rAF loop is efficient but stops itself
  // the instant ONE frame observes the audio paused (a buffering stall, an engine
  // gap-seek, a step swap), and it is throttled — or fully suspended — whenever the
  // embed iframe scrolls out of the feed's viewport (browsers throttle rAF in
  // offscreen cross-origin frames). In both cases the highlight can freeze while the
  // voice plays on, and NO play/visibility event fires to recover it because the tab
  // never lost focus. This cheap timer is the safety net: while audio is genuinely
  // playing it re-arms a dead loop and snaps the highlight back onto the playhead —
  // in the Social embed AND the standalone mini-app (one shared component).
  useEffect(() => {
    const id = setInterval(() => {
      const el = audioRef.current
      const s = syncRef.current
      if (!el || el.paused || el.ended || !cursorRef.current) return
      if (!isFinite(el.currentTime)) return
      if (!s.raf) startLoop()                            // loop died while playing → restart it
      if (s.hasWords) paintWord(idxAt(el.currentTime))   // resync the highlight (throttle/drift/freeze)
    }, 500)
    return () => clearInterval(id)
  }, [startLoop, paintWord, idxAt])

  // When the active block or its word timings change, (re)index the word spans
  // for the sync loop and place the block in the stable zone. While playing the
  // rAF loop does the continuous scroll; while paused we do a one-shot smooth
  // (or snapped, under reduced-motion) scroll so a tap-to-start lands nicely.
  useEffect(() => {
    const s = syncRef.current
    s.lastIdx = -1
    const root = activeBlockRef.current
    if (root && activeWords) {
      const els = Array.from(root.querySelectorAll('.jq-w'))
      s.els = els
      s.timings = els.map((e) => ({ s: parseFloat(e.dataset.s), e: parseFloat(e.dataset.e) }))
      s.hasWords = els.length > 0
      // Silence map + speech/silence budget for the gap-based speed engine
      // (fresh pass, nothing stretched yet).
      s.gaps = buildGaps(activeWords.words, activeWords.dur)
      s.gapMeta = gapMeta(s.gaps, activeWords.dur)
      s.stretched = new Set(); s.pendingSeeks = []
    } else {
      s.els = []; s.timings = []; s.hasWords = false
      s.gaps = []; s.gapMeta = null; s.stretched = new Set(); s.pendingSeeks = []
    }
    const el = audioRef.current
    if (!el || !cursor) return
    if (s.hasWords) paintWord(idxAt(el.currentTime))
    if (el.paused) {
      if (autoScrollRef.current && root) {
        const y = targetYFor(root)
        if (y != null) { window.scrollTo({ top: y, behavior: reduceMotionRef.current ? 'auto' : 'smooth' }); s.curY = y }
      }
    } else {
      startLoop()
    }
  }, [cursor?.n, cursor?.kind, activeWords, paintWord, idxAt, targetYFor, startLoop])

  if (error) return <div className="jq-shell"><div className="jq-error">{error}</div></div>
  if (!surah) return <div className="jq-shell"><div className="jq-loading">{t('loading')}</div></div>

  const active = cursor != null
  const stepLabel = (kind) => (kind === 'recite' ? t('recitation') : kind === 'tafsir' ? t('tafsir') : t('meaning'))
  // Label + karaoke direction follow the clip that is ACTUALLY playing
  // (activeLang), not the settings — during a live language switch the old clip
  // keeps playing for a moment after the setting changes.
  const playingLang = (activeLang && activeLang !== 'ar' ? activeLang : null) || meaningLang
  const langLabel = LANGUAGES.find((l) => l.code === playingLang)?.name || playingLang.toUpperCase()
  const karaokeDir = dirOf(playingLang)
  const playerTitle = active
    // The embed header already names the ayah, so the player just shows the step
    // (+ language). The full reader keeps "· Ayah N" — it tracks position as the
    // read-along moves through the surah.
    ? `${stepLabel(cursor.kind)}${cursor.kind === 'meaning' || cursor.kind === 'tafsir' ? ` · ${langLabel}` : ''}${embed ? '' : ` · ${t('ayah')} ${cursor.n}`}`
    : ''

  return (
    // `jq-focus` while reading dims the non-active ayahs (focus mode) so the eye
    // can't lose its place during a long tafsir.
    <div className={`jq-shell jq-reader${active ? ' has-player jq-focus' : ''}${embed ? ' jq-reader-embed' : ''}`}>
      <header className="jq-reader-bar">
        {!embed && (
          <>
            <Link className="jq-back" to="/surah">‹ {t('back')}</Link>
            {/* THE single surah play/stop control. Reads through the whole surah using
                the current settings, auto-scrolling and highlighting as it goes.
                (The embed has no header play button — its player is always docked
                at the bottom.) */}
            <button
              className={`jq-play jq-reader-play${active ? ' on' : ''}`}
              aria-label={active ? t('stop') : t('playFull')}
              aria-busy={busy}
              title={active ? t('stop') : t('playFull')}
              onClick={toggleSurah}
            >
              {active ? (busy ? '…' : '■') : '▶'}
            </button>
          </>
        )}
        <div className="jq-reader-title">
          {/* Embed shows just the ayah identity (surah name + ayah number) — no
              "Surah" prefix; the shared unit is the ayah. */}
          <span className="jq-reader-fa">{embed ? `${surah.nameFa} · ${t('ayah')} ${focusAyah}` : `${t('surah')} ${surah.nameFa}`}</span>
          <span className="jq-reader-en">{surah.nameEn}{embed ? '' : ` · ${surah.ayahs.length} ${t('ayahs')}`}</span>
        </div>
        {embed && (
          <EmbedControls
            meaningLang={meaningLang} onLang={setMeaningLang} langs={MEANING_LANGS}
            tafsirMode={tafsirMode} onTafsir={setTafsirMode}
            reciters={reciters} reciter={reciter}
            onReciter={(id) => { setReciter(id); setReciterLocal(id) }}
            reciteArabic={reciteArabic} onReciteArabic={setReciteArabic}
          />
        )}
      </header>

      {/* Honest "audio being prepared" note, or a retryable load error — never a
          raw provider error, never a dead end. */}
      {shareNote && <div className="jq-listen-note" role="status">{shareNote}</div>}
      {note && <div className="jq-listen-note">{note}</div>}
      {playErr && (
        <div className="jq-listen-note jq-listen-err" role="alert">
          ⚠︎ {playErr.msg}
          <button className="jq-chip jq-retry" onClick={retry}>{t('retry')}</button>
        </div>
      )}

      {/* Static basmala line for surahs whose ayah 1 is not itself the basmala. */}
      {!embed && surahNum !== 1 && surahNum !== 9 && (
        <div className="jq-basmala jq-basmala-static">بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ</div>
      )}

      <ol className="jq-ayahs">
        {(embed ? surah.ayahs.filter((a) => a.n === focusAyah) : surah.ayahs).map((a) => {
          const isCur = cursor?.n === a.n
          const readKind = isCur ? cursor.kind : null
          const meaning = meaningOf(a, meaningLang)
          const tafsirOn = tafsirMode === 'long' || tafsirMode === 'short'
          const tx = tafsirOn ? txOf(a.n) : null
          // Tapping the card starts playback FROM this ayah with current settings.
          return (
            <li
              key={a.n}
              className={`jq-ayah${isCur ? ' playing' : ''}`}
              onClick={() => startAt(a.n)}
            >
              {/* Ayah head — full reader only. It carries the number badge + the
                  share-to-social chip. The per-ayah 💬 comment icon was removed
                  everywhere (owner: "remove the comment icon, keep the Comments
                  section, I like this style") — commenting lives in the collapsible
                  "Comments on this surah" section below. The embed drops this whole
                  row to reclaim the wasted height. */}
              {!embed && (
                <div className="jq-ayah-head">
                  <span className="jq-ayah-num">{a.n}</span>
                  <button
                    className="jq-chip jq-share-btn"
                    aria-label={`${t('shareAyah') || 'Share ayah'} ${a.n}`}
                    title={t('shareAyah') || 'Share ayah'}
                    onClick={(e) => { e.stopPropagation(); doShareAyah(a.n) }}
                  >↗</button>
                </div>
              )}

              <p
                ref={readKind === 'recite' ? activeBlockRef : null}
                className={`jq-ar${readKind === 'recite' && !activeWords ? ' jq-reading' : ''}`}
                dir="rtl"
              >
                {readKind === 'recite' && activeWords
                  ? <KaraokeText words={activeWords.words} onSeekWord={seekToWord} />
                  : a.ar}
                {' '}<span className="jq-ayah-marker">﴿{toArabicDigits(a.n)}﴾</span>
              </p>

              {/* The meaning in the CHOSEN language only (no stacked languages).
                  With "read insertions" ON we show the text as-is (the translator's
                  [..]/(..) runs muted); OFF we show the stripped text that matches
                  the `.noann` audio. */}
              {meaning && (
                <p
                  ref={readKind === 'meaning' ? activeBlockRef : null}
                  className={`jq-meaning ${mDir === 'rtl' ? 'jq-fa' : 'jq-en'}${readKind === 'meaning' && !activeWords ? ' jq-reading' : ''}`}
                  dir={readKind === 'meaning' && activeWords ? karaokeDir : mDir}
                >
                  {readKind === 'meaning' && activeWords
                    ? <KaraokeText words={activeWords.words} onSeekWord={seekToWord} />
                    : (readAnnotations ? renderMeaning(meaning) : meaningForDisplay(meaning, false))}
                  {/* No verse number on the translation — the Arabic ﴿N﴾ marker just
                      above already carries it (owner: don't repeat the ayah number). */}
                </p>
              )}

              {/* Tafsir text for this ayah (lecture/summary transcript, or its
                  translation) — shown for both LONG and SHORT, with live karaoke. */}
              {tafsirOn && (
                <div
                  ref={readKind === 'tafsir' ? activeBlockRef : null}
                  className={`jq-tafsir-panel${readKind === 'tafsir' && !activeWords ? ' jq-reading' : ''}`}
                  dir={readKind === 'tafsir' && activeWords ? karaokeDir : mDir}
                >
                  {!tx ? (
                    <div className="jq-loading">{t('loading')}</div>
                  ) : tx.text ? (
                    <p className="jq-tafsir-text" dir={readKind === 'tafsir' && activeWords ? karaokeDir : mDir}>
                      {readKind === 'tafsir' && activeWords
                        ? <KaraokeText words={activeWords.words} onSeekWord={seekToWord} />
                        : stripEventTags(tx.text)}
                    </p>
                  ) : (
                    <div className="jq-transcript-empty">
                      <span>{tx.error ? `⚠︎ ${tx.error}` : tx.note || t('noTranscript')}</span>
                    </div>
                  )}
                </div>
              )}

              {openComments === a.n && (
                <div onClick={(e) => e.stopPropagation()}>
                  <Comments surah={surahNum} ayah={a.n} onCount={(c) => setCommentCounts((m) => ({ ...m, [a.n]: c }))} />
                </div>
              )}
            </li>
          )
        })}
      </ol>

      <section className="jq-surah-comments">
        <button
          className={`jq-section-toggle${openComments === 0 ? ' open' : ''}`}
          onClick={() => setOpenComments(openComments === 0 ? null : 0)}
        >
          💬 {t('surahComments')}{commentCounts[0] ? ` (${commentCounts[0]})` : ''}
          <span className="jq-caret">{openComments === 0 ? '▾' : '▸'}</span>
        </button>
        {openComments === 0 && (
          <Comments surah={surahNum} ayah={0} onCount={(c) => setCommentCounts((m) => ({ ...m, 0: c }))} />
        )}
      </section>

      {/* Surah prev/next belongs to the full reader only — a single-ayah embed
          has nowhere to navigate. */}
      {!embed && (
        <nav className="jq-surah-nav">
          {surahNum > 1 && <Link className="jq-chip" to={`/surah/${surahNum - 1}`}>‹ {t('prevSurah')}</Link>}
          {surahNum < 114 && <Link className="jq-chip" to={`/surah/${surahNum + 1}`}>{t('nextSurah')} ›</Link>}
        </nav>
      )}

      {/* The embed player is ALWAYS docked at the bottom (owner: "always show
          player at bottom, remove the top-left play button"). When nothing is
          playing it renders idle — the ▶ starts THIS ayah. The full reader keeps
          the on-demand player. */}
      {(active || embed) && (
        <Player
          audioRef={audioRef}
          idle={!active}
          embed={embed}
          onPlay={() => startAt(focusAyah)}
          busy={busy}
          paused={paused}
          speed={speed}
          onCycleSpeed={cycleSpeed}
          onTogglePause={togglePause}
          onPrevAyah={prevAyah}
          onNextAyah={nextAyah}
          onSeekBy={seekBy}
          onScrub={onScrub}
          onStop={stop}
          canPrev={active && !embed ? cursor.n > 1 : false}
          canNext={active && !embed ? cursor.n < surah.ayahs.length : false}
          title={active ? playerTitle : ''}
          following={following}
          onRecenter={recenter}
        />
      )}

      <audio
        ref={audioRef}
        onEnded={onEnded}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        preload="none"
      />
    </div>
  )
}
