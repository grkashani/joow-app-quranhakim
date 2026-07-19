import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { loadSurah, recitationAudioUrl } from '../lib/data.js'
import { getDedicatedTafsir, tafsirAudioUrlFor } from '../lib/tafsir.js'
import { getCached, setCached, getServerTranscript, contributeTranscript, localeFor } from '../lib/transcribe.js'
import { getTtsSegmentUrl } from '../lib/tts.js'
import { isIosSpeechAvailable, isLocaleSupportedOnDevice, transcribeOnDevice } from '../lib/iosSpeech.js'
import { fetchCommentCounts } from '../lib/comments.js'
import Comments from '../components/Comments.jsx'
import { useI18n, LANGUAGES } from '../lib/i18n.jsx'
import { getReadingLangs, READING_LANGS_EVENT } from '../lib/settings.js'

// Language choice lives in the Settings drawer (ONE list, jq.labLangs — see
// settings.js). The reader simply renders the configured languages: translation
// lines under each ayah AND the Language Lab study rows in the transcript panel,
// where the tafsir is shown sentence-by-sentence, source (Persian) first.
const SEG_TOL = 0.3 // seconds of tolerance when slicing the fa word stream to a segment window

// Digit sets for the mushaf-style inline ayah markers: ﴿٣﴾ after the Arabic,
// (۳) after the Persian translation, (3) after the English.
const toArabicDigits = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d])
const toFaDigits = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d])

const fmtTime = (s) => {
  if (!isFinite(s) || s <= 0) return '0:00'
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${m}:${String(ss).padStart(2, '0')}`
}

// Persian sentence for a segment window: the fa transcript's words[] sliced to [s,e] (±tolerance).
function sliceWords(words, seg) {
  if (!Array.isArray(words) || !words.length || !seg) return ''
  return words
    .filter((w) => w.s >= seg.s - SEG_TOL && w.e <= seg.e + SEG_TOL)
    .map((w) => w.t)
    .join(' ')
}

export default function Reader() {
  const { t } = useI18n()
  const { num } = useParams()
  const surahNum = Number(num)
  const [surah, setSurah] = useState(null)
  const [error, setError] = useState(null)

  // Dedicated tafsir (this app ships with exactly one — Bazargan).
  const [tafsir, setTafsir] = useState(null)
  // The tafsir's SOURCE language (Persian for Bazargan) — always shown first in the lab.
  const srcLang = tafsir?.transcript?.lang || tafsir?.language || 'fa'

  // Reading languages: the ONE list chosen in the Settings drawer. Live-updates
  // while the drawer is open via the settings event.
  const [readingLangs, setReadingLangs] = useState(getReadingLangs)
  useEffect(() => {
    const h = (e) => setReadingLangs(e.detail)
    window.addEventListener(READING_LANGS_EVENT, h)
    return () => window.removeEventListener(READING_LANGS_EVENT, h)
  }, [])
  // Language Lab rows = the chosen languages minus the source (fa is always the
  // lab's source row, whether or not it is a chosen reading language).
  const labLangs = useMemo(() => readingLangs.filter((l) => l !== srcLang), [readingLangs, srcLang])
  const primary = labLangs[0] || srcLang // drives sentence view + full-transcript TTS
  // "Listen" language = the FIRST reading language. If it is the tafsir's source
  // language (fa), Listen plays the ORIGINAL recording; otherwise it plays that
  // language's per-sentence TTS clips as a playlist.
  const listenLang = readingLangs[0] || srcLang

  // transcripts keyed `${lang}:${ayah}` -> { text, source, words?, segments?, ... }
  const [transcripts, setTranscripts] = useState({})
  const trOf = (n, l) => transcripts[`${l}:${n}`]
  const inflight = useRef(new Set())
  const [openTr, setOpenTr] = useState(null)
  const [trStatus, setTrStatus] = useState(null) // { ayah, msg }
  const [segBusy, setSegBusy] = useState(null) // `${n}:${lang}:${i}` while a sentence clip is being fetched
  const [seqErr, setSeqErr] = useState(null) // {n, lang, i, msg}: a Listen playlist clip failed on THIS sentence
  const [canDeviceSTT, setCanDeviceSTT] = useState(false) // iOS-only (free + contributes); web ALWAYS uses the backend

  // comments: counts per ayah (0 = surah-level); which thread is open
  const [commentCounts, setCommentCounts] = useState({})
  const [openComments, setOpenComments] = useState(null) // ayah number, or 0 for surah-level

  const [playing, setPlaying] = useState(null)
  const [continuous, setContinuous] = useState(false)
  const audioRef = useRef(null)
  // End-of-window auto-pause for Persian sentence playback (original tafsir audio
  // sliced [s,e]) — checked on the existing timeupdate tick, no new timers.
  const segEndRef = useRef(null)

  // Playback speed (applies to recitation, tafsir, and TTS). Persisted; live-applied.
  const [speed, setSpeed] = useState(() => Number(localStorage.getItem('jq.speed')) || 1)
  const speedRef = useRef(speed)
  useEffect(() => {
    speedRef.current = speed
    localStorage.setItem('jq.speed', String(speed))
    if (audioRef.current) audioRef.current.playbackRate = speed
  }, [speed])

  // Seek-bar player state: position/duration (throttled to ~2Hz) + paused flag.
  const [prog, setProg] = useState({ t: 0, d: 0 })
  const [paused, setPaused] = useState(false)
  const lastTRef = useRef(0)
  const onTime = useCallback((e) => {
    const el = e.target
    const t = el.currentTime, d = el.duration || 0
    // Sentence slice reached its end window -> auto-pause (Language Lab fa rows).
    if (segEndRef.current != null && t >= segEndRef.current) {
      segEndRef.current = null
      el.pause()
      setPlaying(null)
    }
    if (Math.abs(t - lastTRef.current) >= 0.5 || d !== prog.d) { lastTRef.current = t; setProg({ t, d }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prog.d])
  const seek = useCallback((v) => { const el = audioRef.current; if (el && isFinite(v)) el.currentTime = v }, [])

  // ---- Vertical progress rail (right screen edge) ----
  // Fill/thumb ride the same ~2Hz prog state as the player — no new timers.
  // Pointer down/drag anywhere on the rail maps y -> time onto the existing seek().
  const railRef = useRef(null)
  const railDragRef = useRef(false)
  const railSeekAt = useCallback((clientY) => {
    const rail = railRef.current
    const d = audioRef.current?.duration
    if (!rail || !isFinite(d) || d <= 0) return
    const r = rail.getBoundingClientRect()
    if (!r.height) return
    const f = Math.min(1, Math.max(0, (clientY - r.top) / r.height))
    seek(f * d)
  }, [seek])
  const togglePause = useCallback(() => {
    const el = audioRef.current
    if (!el || !el.src) return
    if (el.paused) el.play().catch(() => {})
    else el.pause()
  }, [])

  useEffect(() => { getDedicatedTafsir().then((tf) => setTafsir((cur) => cur || tf)) }, [])

  useEffect(() => {
    setSurah(null); setPlaying(null); setTranscripts({}); setOpenTr(null); setOpenComments(null); setSeqErr(null)
    loadSurah(surahNum)
      .then((s) => { setSurah(s); localStorage.setItem('jq.lastRead', JSON.stringify({ surah: surahNum, nameFa: s.nameFa })) })
      .catch((e) => setError(String(e)))
    fetchCommentCounts(surahNum).then(setCommentCounts).catch(() => setCommentCounts({}))
    window.scrollTo(0, 0)
  }, [surahNum])

  useEffect(() => { setTranscripts({}); setOpenTr(null) }, [tafsir])

  // On-device transcription is only offered when the tafsir's pinned STT engine allows it.
  // Bazargan pins engines.stt = 'elevenlabs' → server-only (no on-device / in-browser Whisper).
  // A tafsir may opt in with engines.stt === 'device'; then iOS is gated on Apple locale support.
  useEffect(() => {
    if (!tafsir) return
    const stt = tafsir.engines?.stt
    if (stt && stt !== 'device') { setCanDeviceSTT(false); return } // pinned to a server engine (e.g. elevenlabs)
    if (!isIosSpeechAvailable()) { setCanDeviceSTT(false); return } // web: backend-only by owner directive
    let alive = true
    setCanDeviceSTT(false)
    isLocaleSupportedOnDevice(localeFor(tafsir)).then((r) => { if (alive) setCanDeviceSTT(!!r.supported) })
    return () => { alive = false }
  }, [tafsir])

  const play = useCallback((n, kind) => {
    const el = audioRef.current
    if (!el) return
    segEndRef.current = null
    el.src = kind === 'tafsir' && tafsir ? tafsirAudioUrlFor(tafsir, surahNum, n) : recitationAudioUrl(surahNum, n)
    el.playbackRate = speedRef.current
    el.play().then(() => setPlaying({ n, kind })).catch(() => setPlaying(null))
  }, [surahNum, tafsir])

  // The basmala has ONE recording shared by every surah: Al-Fatiha 1:1, which IS
  // "بسم الله الرحمن الرحیم". Played on the basmala line of every other surah.
  const playBasmala = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    segEndRef.current = null
    el.src = recitationAudioUrl(1, 1)
    el.playbackRate = speedRef.current
    el.play().then(() => setPlaying({ n: 0, kind: 'basmala' })).catch(() => setPlaying(null))
  }, [])

  const stop = useCallback(() => {
    const el = audioRef.current
    if (el) { el.pause(); el.removeAttribute('src') }
    segEndRef.current = null
    setPlaying(null); setContinuous(false)
    setProg({ t: 0, d: 0 }); setPaused(false); lastTRef.current = 0
  }, [])

  const toggle = useCallback((n, kind) => {
    if (playing && playing.n === n && playing.kind === kind) stop(); else play(n, kind)
  }, [playing, play, stop])

  // ---- Listen: a continuous, read-along SENTENCE playlist for one ayah ----
  // The language is the FIRST reading language (listenLang). Two shapes:
  //   SOURCE (fa): play the ORIGINAL tafsir recording as ONE continuous file and
  //     highlight the active sentence by segment time (no synthesis, no clips).
  //   OTHER lang : play that language's per-sentence TTS clips in order — each
  //     clip's 'ended' advances to i+1 (see onEnded). A clip that errors
  //     (billing/404) shows an inline notice on that sentence and STOPS cleanly.

  // Source-language Listen: the whole tafsir audio; highlight rides segment times.
  const startListenSrc = useCallback((n) => {
    const el = audioRef.current
    if (!el || !tafsir) return
    segEndRef.current = null
    el.src = tafsirAudioUrlFor(tafsir, surahNum, n)
    el.playbackRate = speedRef.current
    el.play().then(() => setPlaying({ n, kind: 'listen', lang: srcLang })).catch(() => setPlaying(null))
  }, [tafsir, surahNum, srcLang])

  // Added-language Listen: play sentence clip i, then i+1 on 'ended'.
  const startListenSeq = useCallback(async (n, lang, i) => {
    const el = audioRef.current
    if (!el || !tafsir) return
    const segs = trOf(n, lang)?.segments
    if (!segs?.length) { setPlaying(null); return }
    if (i >= segs.length) { stop(); return } // every sentence played -> done, clean stop
    segEndRef.current = null
    try {
      const url = await getTtsSegmentUrl(tafsir, surahNum, n, lang, i) // get-or-create: only cached clips play
      el.src = url
      el.playbackRate = speedRef.current
      await el.play()
      setPlaying({ n, kind: 'listenseq', lang, i })
    } catch (err) {
      // Billing down / 404 / not-yet-synthesized: a concise notice on THIS sentence,
      // then stop the playlist clean (no retry loop). The raw provider error (e.g. an
      // ElevenLabs payment-required blob) is logged, never shown to the reader.
      console.warn('[listen] sentence clip unavailable', { n, lang, i, err: String(err?.message || err) })
      setSeqErr({ n, lang, i, msg: t('ttsUnavailable') })
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tafsir, surahNum, transcripts, stop, t])

  // The Listen button: toggle play/stop for this ayah.
  const listen = useCallback((n) => {
    if (playing && (playing.kind === 'listen' || playing.kind === 'listenseq') && playing.n === n) { stop(); return }
    setSeqErr(null)
    if (listenLang === srcLang) startListenSrc(n)
    else startListenSeq(n, listenLang, 0)
  }, [playing, stop, listenLang, srcLang, startListenSrc, startListenSeq])

  // ---- Karaoke word sync (tafsir audio + word-timestamped source transcript) ----
  // Click a word → seek the tafsir audio to its start. If that ayah's tafsir is
  // already loaded in the player just scrub; otherwise load it, seek, and play.
  const seekWord = useCallback((n, s) => {
    const el = audioRef.current
    if (!el || !isFinite(s)) return
    segEndRef.current = null
    if (playing && playing.kind === 'tafsir' && playing.n === n && el.src) {
      el.currentTime = s
      if (el.paused) el.play().catch(() => {})
      return
    }
    if (!tafsir) return
    el.src = tafsirAudioUrlFor(tafsir, surahNum, n)
    el.playbackRate = speedRef.current
    el.addEventListener('loadedmetadata', () => { try { el.currentTime = s } catch { /* not seekable yet */ } }, { once: true })
    el.play().then(() => setPlaying({ n, kind: 'tafsir' })).catch(() => setPlaying(null))
  }, [playing, tafsir, surahNum])

  // Current word index for the playing tafsir, derived from the ~2Hz onTime tick
  // (prog.t) — no extra timer. Binary search: last word whose start <= t. It
  // stays highlighted THROUGH the silence gap after it ends (until the next word
  // begins), so the reader never loses their place during a pause. Karaoke
  // follows the SOURCE (fa) words.
  const wordIdx = (() => {
    if (!playing || playing.kind !== 'tafsir') return -1
    const words = trOf(playing.n, srcLang)?.words
    if (!words || !words.length) return -2 // playing but no timings
    const t = prog.t
    let lo = 0, hi = words.length - 1, ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (words[mid].s <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
    }
    return ans // persists during silence — no `t <= end` reset
  })()
  // The upcoming word, shown in a lighter shade as a "coming next" cue. Before
  // the first word (intro silence, wordIdx === -1) the next word is word 0.
  const nextWordIdx = playing?.kind === 'tafsir' && wordIdx >= -1 ? wordIdx + 1 : -1
  // The word to keep scrolled into view: the current one, or the upcoming one
  // during the lead-in silence before any word has started.
  const focusWordIdx = wordIdx >= 0 ? wordIdx : nextWordIdx

  // Keep the focused word visible inside the transcript panel — only when it changes.
  const activeWordRef = useRef(null)
  useEffect(() => {
    if (focusWordIdx >= 0) activeWordRef.current?.scrollIntoView({ block: 'nearest' })
  }, [focusWordIdx, playing?.n, playing?.kind])

  // ---- Always-on read-along ----
  // ONE derived {n, i, lang} from prog.t + playing: which sentence block (Language
  // Lab study view) is being spoken right now, whatever the source:
  //   listen    -> source-language Listen: sentence by segment time (highlight fa row)
  //   listenseq -> added-language Listen playlist: the exact clip index + its lang
  //   tafsir    -> timed segments of the primary language (s <= t <= e)
  //   segfa     -> the sliced sentence being played (exact, playing.i)
  //   seg       -> the per-sentence TTS clip being played (exact, playing.i + its lang)
  //   recit/basmala -> null (the ayah-card highlight already covers those)

  const active = (() => {
    if (!playing) return null
    const t = prog.t
    if (playing.kind === 'segfa') return { n: playing.n, i: playing.i, lang: srcLang }
    if (playing.kind === 'seg') return { n: playing.n, i: playing.i, lang: playing.l }
    if (playing.kind === 'listenseq') return { n: playing.n, i: playing.i, lang: playing.lang }
    // Full tafsir OR source-language Listen: the sentence whose segment window
    // (from the primary/timed transcript) contains t. Highlight the source (fa) row.
    if (playing.kind === 'tafsir' || playing.kind === 'listen') {
      const segs = trOf(playing.n, primary)?.segments
      if (!segs?.length) return null
      const i = segs.findIndex((sg) => sg.s <= t && t <= sg.e)
      return i >= 0 ? { n: playing.n, i, lang: srcLang } : null
    }
    return null
  })()

  // Player-bar label + sentence count for the active Listen session.
  const listenLangCode = playing?.kind === 'listenseq' ? playing.lang : playing?.kind === 'listen' ? srcLang : null
  const listenLangLabel = listenLangCode ? (LANGUAGES.find((l) => l.code === listenLangCode)?.name || listenLangCode.toUpperCase()) : ''

  // Keep the active sentence block visible — only when the block itself changes.
  const activeSentRef = useRef(null)
  useEffect(() => {
    if (active?.i != null) activeSentRef.current?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.n, active?.i, active?.lang])

  const onEnded = useCallback(() => {
    segEndRef.current = null
    // Listen playlist: advance to the next sentence clip (stops itself when done).
    if (playing?.kind === 'listenseq') { startListenSeq(playing.n, playing.lang, playing.i + 1); return }
    if (!continuous || !surah || !playing) { setPlaying(null); return }
    if (playing.kind === 'basmala') { play(1, 'recit'); return } // basmala flows into ayah 1
    if (playing.kind !== 'recit') { setPlaying(null); return }
    const next = playing.n + 1
    if (next <= surah.ayahs.length) play(next, 'recit')
    else { setPlaying(null); setContinuous(false) }
  }, [continuous, surah, playing, play, startListenSeq])

  // One language's transcript for one ayah: local cache -> server get-or-create.
  async function fetchTranscript(n, l) {
    const k = `${l}:${n}`
    if (inflight.current.has(k)) return
    const cached = getCached(tafsir.id, l, surahNum, n)
    if (cached) { setTranscripts((m) => (m[k] ? m : { ...m, [k]: cached })); return }
    inflight.current.add(k)
    try {
      const r = await getServerTranscript(tafsir, surahNum, n, l)
      const e = { text: r.text, source: r.source, translated: r.translated, words: r.words, segments: r.segments }
      setCached(tafsir.id, l, surahNum, n, e)
      setTranscripts((m) => ({ ...m, [k]: e }))
    } catch (err) {
      setTranscripts((m) => ({ ...m, [k]: { text: '', source: 'unavailable', error: String(err.message || err) } }))
    }
    inflight.current.delete(k)
  }

  // Load everything the open panel needs: the source (fa) transcript — words for
  // karaoke + sentence slicing — plus every ADDED language (segments + text).
  async function ensureTranscripts(n) {
    if (!tafsir) return
    const langs = [...new Set([srcLang, ...labLangs])]
    const missing = langs.filter((l) => !transcripts[`${l}:${n}`])
    if (!missing.length) return
    setTrStatus({ ayah: n, msg: t('transcribing') })
    await Promise.all(missing.map((l) => fetchTranscript(n, l)))
    setTrStatus(null)
  }
  async function openTranscript(n) {
    if (openTr === n) { setOpenTr(null); return }
    setOpenTr(n)
    ensureTranscripts(n)
  }

  // A language change in Settings (or opening another ayah) fetches whatever is missing.
  useEffect(() => {
    if (openTr != null) ensureTranscripts(openTr)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labLangs, openTr, tafsir])

  async function transcribe(n) { // iOS native on-device only; every other platform uses the backend
    if (!tafsir || !isIosSpeechAvailable()) return
    const l = srcLang
    setTrStatus({ ayah: n, msg: t('transcribing') })
    try {
      // Native Apple on-device speech; then share the result with everyone.
      const text = await transcribeOnDevice(tafsirAudioUrlFor(tafsir, surahNum, n), localeFor(tafsir))
      contributeTranscript(tafsir, surahNum, n, l, text, 'device-ios')
      const e = { text, source: 'device' }
      setCached(tafsir.id, l, surahNum, n, e)
      setTranscripts((m) => ({ ...m, [`${l}:${n}`]: e }))
    } catch (err) {
      // Unsupported locale on-device (e.g. Persian) → get it from the server instead.
      if (err?.code === 'locale-unsupported' || err?.code === 'ios-only') {
        await fetchTranscript(n, primary)
      } else {
        setTranscripts((m) => ({ ...m, [`${l}:${n}`]: { text: `⚠︎ ${String(err.message || err)}`, source: 'error' } }))
      }
    }
    setTrStatus(null)
  }

  // ---- Language Lab sentence playback ----
  // Persian row: play the ORIGINAL tafsir audio sliced to the segment window [s,e].
  // Auto-pause at e happens on the shared timeupdate tick (segEndRef) — no timers.
  function playSegFa(n, seg, i) {
    const el = audioRef.current
    if (!el || !tafsir || !seg) return
    if (playing?.kind === 'segfa' && playing.n === n && playing.i === i) { stop(); return }
    // Same ayah's tafsir already loaded (full play or another sentence)? Just scrub.
    if (playing && playing.n === n && (playing.kind === 'tafsir' || playing.kind === 'segfa') && el.src) {
      segEndRef.current = seg.e
      el.currentTime = seg.s
      el.play().then(() => setPlaying({ n, kind: 'segfa', i })).catch(() => setPlaying(null))
      return
    }
    segEndRef.current = seg.e
    el.src = tafsirAudioUrlFor(tafsir, surahNum, n)
    el.playbackRate = speedRef.current
    el.addEventListener('loadedmetadata', () => { try { el.currentTime = seg.s } catch { /* not seekable yet */ } }, { once: true })
    el.play().then(() => setPlaying({ n, kind: 'segfa', i })).catch(() => setPlaying(null))
  }

  // Added-language row: per-sentence TTS clip — server get-or-create (paid once
  // ever), then played through the shared audio element.
  async function playSegTts(n, l, i) {
    const el = audioRef.current
    if (!el || !tafsir) return
    if (playing?.kind === 'seg' && playing.n === n && playing.l === l && playing.i === i) { stop(); return }
    segEndRef.current = null
    setSegBusy(`${n}:${l}:${i}`)
    try {
      const url = await getTtsSegmentUrl(tafsir, surahNum, n, l, i)
      el.src = url
      el.playbackRate = speedRef.current
      await el.play()
      setPlaying({ n, kind: 'seg', l, i })
    } catch (err) {
      const k = `${l}:${n}`
      setTranscripts((m) => ({ ...m, [k]: { ...(m[k] || {}), ttsError: err.status === 503 ? t('ttsUnavailable') : String(err.message || err) } }))
    }
    setSegBusy(null)
  }

  if (error) return <div className="jq-shell"><div className="jq-error">{error}</div></div>
  if (!surah) return <div className="jq-shell"><div className="jq-loading">{t('loading')}</div></div>

  const isPlaying = (n, kind) => playing && playing.n === n && playing.kind === kind
  // Listen is "on" for ayah n whether it's the source recording or a clip playlist.
  const listenOn = (n) => playing && (playing.kind === 'listen' || playing.kind === 'listenseq') && playing.n === n

  return (
    <div className={`jq-shell jq-reader${playing ? ' has-player' : ''}`}>
      <header className="jq-reader-bar">
        <Link className="jq-back" to="/surah">‹ {t('back')}</Link>
        {/* Play-full-surah lives here, beside the surah name. Opens with the
            basmala (except surahs 1 and 9) then flows through every ayah. */}
        <button
          className={`jq-play jq-reader-play${continuous ? ' on' : ''}`}
          aria-label={continuous ? t('stop') : t('playFull')}
          title={continuous ? t('stop') : t('playFull')}
          onClick={() => {
            if (continuous) { stop(); return }
            setContinuous(true)
            if (surahNum !== 1 && surahNum !== 9) playBasmala()
            else play(1, 'recit')
          }}
        >
          {continuous ? '■' : '▶'}
        </button>
        <div className="jq-reader-title">
          <span className="jq-reader-fa">{t('surah')} {surah.nameFa}</span>
          <span className="jq-reader-en">{surah.nameEn} · {surah.ayahs.length} {t('ayahs')}</span>
        </div>
      </header>

      {surahNum !== 1 && surahNum !== 9 && (
        <button
          className={`jq-basmala${isPlaying(0, 'basmala') ? ' playing' : ''}`}
          onClick={() => (isPlaying(0, 'basmala') ? stop() : playBasmala())}
          aria-label={t('basmala')}
        >
          <span className="jq-basmala-play">{isPlaying(0, 'basmala') ? '❚❚' : '▶'}</span>
          بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ
        </button>
      )}

      <ol className="jq-ayahs">
        {surah.ayahs.map((a) => {
          const faEntry = trOf(a.n, srcLang)
          const primaryEntry = trOf(a.n, primary)
          const segs = primary !== srcLang ? primaryEntry?.segments : null
          const shownEntry = (primaryEntry?.text ? primaryEntry : faEntry) || primaryEntry || faEntry
          return (
          <li key={a.n} className={`jq-ayah${playing && playing.n === a.n ? ' playing' : ''}`}>
            <div className="jq-ayah-head">
              <div className="jq-ayah-actions">
                <button className={`jq-play${isPlaying(a.n, 'recit') ? ' on' : ''}`} aria-label={`${t('recitationPack')} ${a.n}`} onClick={() => toggle(a.n, 'recit')}>
                  {isPlaying(a.n, 'recit') ? '❚❚' : '▶'}
                </button>
                <button className={`jq-tafsir${isPlaying(a.n, 'tafsir') ? ' on' : ''}`} aria-label={`${t('tafsir')} ${a.n}`} onClick={() => toggle(a.n, 'tafsir')}>
                  {isPlaying(a.n, 'tafsir') ? `❚❚ ${t('tafsir')}` : `❯ ${t('tafsir')}`}
                </button>
                <button className={`jq-chip jq-tr-btn${openTr === a.n ? ' active' : ''}`} onClick={() => openTranscript(a.n)}>
                  ≡ {t('transcript')}
                </button>
                <button className={`jq-chip jq-cm-btn${openComments === a.n ? ' active' : ''}`} aria-label={`${t('comments')} ${a.n}`} onClick={() => setOpenComments(openComments === a.n ? null : a.n)}>
                  💬{commentCounts[a.n] ? ` ${commentCounts[a.n]}` : ''}
                </button>
              </div>
            </div>
            <p className="jq-ar" dir="rtl">{a.ar} <span className="jq-ayah-marker">﴿{toArabicDigits(a.n)}﴾</span></p>
            {/* Translation/meaning lines for exactly the configured reading languages. */}
            {readingLangs.includes('fa') && a.fa && <p className="jq-fa" dir="rtl">{a.fa} <span className="jq-tr-num">({toFaDigits(a.n)})</span></p>}
            {readingLangs.includes('en') && a.en && <p className="jq-en" dir="ltr">{a.en} <span className="jq-tr-num">({a.n})</span></p>}
            {readingLangs.filter((l) => l !== 'fa' && l !== 'en' && a.t?.[l]).map((l) => (
              <p key={l} className="jq-en" dir="auto">{a.t[l]} <span className="jq-tr-num">({a.n})</span></p>
            ))}

            {openTr === a.n && (
              <div className="jq-transcript">
                <div className="jq-transcript-src">
                  <span>
                    {shownEntry?.source === 'elevenlabs-scribe' ? '☁︎' : shownEntry?.source === 'translation' ? '🌐' : shownEntry?.source === 'device' ? '📱' : '☁︎'} {t('transcript')}
                    {shownEntry?.translated === false ? ` · ${t('faTr')}` : ''}
                  </span>
                  <button className={`jq-chip jq-tts-btn${isPlaying(a.n, 'recit') ? ' active' : ''}`} onClick={() => toggle(a.n, 'recit')}>
                    {isPlaying(a.n, 'recit') ? '❚❚' : '▶'} {t('playAyah')}
                  </button>
                  <button className={`jq-chip jq-tts-btn${listenOn(a.n) ? ' active' : ''}`} onClick={() => listen(a.n)}>
                    {listenOn(a.n) ? `❚❚ ${t('listening')}` : `🔊 ${t('listen')}`}
                  </button>
                </div>

                {trStatus?.ayah === a.n ? (
                  <div className="jq-loading">{trStatus.msg}</div>
                ) : shownEntry?.text ? (
                  <>
                    {faEntry?.words?.length && isPlaying(a.n, 'tafsir') ? (
                      // Karaoke mode wins: tafsir audio for THIS ayah is playing full and
                      // the source transcript has word timestamps → time-synced words.
                      <p dir="rtl">
                        {faEntry.words.map((w, i) => [
                          <span
                            key={i}
                            className={`jq-word${i === wordIdx ? ' on' : i === nextWordIdx ? ' next' : ''}`}
                            ref={i === focusWordIdx ? activeWordRef : null}
                            onClick={() => seekWord(a.n, w.s)}
                          >
                            {w.t}
                          </span>,
                          ' ',
                        ])}
                      </p>
                    ) : segs?.length ? (
                      // Sentence study view: numbered blocks — Persian sentence first
                      // (fa words sliced to the segment window), then one row per added language.
                      <ol className="jq-sentences">
                        {segs.map((seg, i) => {
                          const faText = sliceWords(faEntry?.words, seg)
                          const faOn = playing?.kind === 'segfa' && playing.n === a.n && playing.i === i
                          // Read-along: this block is the one being spoken right now.
                          const live = active != null && active.n === a.n && active.i === i
                          return (
                            <li
                              key={i}
                              ref={live ? activeSentRef : null}
                              className={`jq-sentence${live ? ' live' : ''}`}
                            >
                              <span className="jq-sentence-num" aria-label={`${t('sentence')} ${i + 1}`}>{i + 1}</span>
                              <div className="jq-sentence-rows">
                                {faText && (
                                  <div className={`jq-study-row jq-study-src${live && active.lang === srcLang ? ' live' : ''}`}>
                                    <span className="jq-lang-badge">{srcLang}</span>
                                    <span className="jq-study-text" dir="auto">{faText}</span>
                                    <button className={`jq-study-play${faOn ? ' on' : ''}`} aria-label={`${t('sentence')} ${i + 1} ${srcLang}`} onClick={() => playSegFa(a.n, seg, i)}>
                                      {faOn ? '❚❚' : '▶'}
                                    </button>
                                  </div>
                                )}
                                {labLangs.map((l) => {
                                  const txt = trOf(a.n, l)?.segments?.[i]?.text
                                  if (!txt) return null
                                  const on = playing?.kind === 'seg' && playing.n === a.n && playing.l === l && playing.i === i
                                  const busy = segBusy === `${a.n}:${l}:${i}`
                                  const seqFailed = seqErr && seqErr.n === a.n && seqErr.lang === l && seqErr.i === i
                                  return (
                                    <div key={l} className={`jq-study-row${live && active.lang === l ? ' live' : ''}${seqFailed ? ' err' : ''}`}>
                                      <span className="jq-lang-badge">{l}</span>
                                      <span className="jq-study-text" dir="auto">{txt}</span>
                                      <button className={`jq-study-play${on ? ' on' : ''}`} aria-label={`${t('sentence')} ${i + 1} ${l}`} onClick={() => playSegTts(a.n, l, i)}>
                                        {busy ? '…' : on ? '❚❚' : '▶'}
                                      </button>
                                      {seqFailed && <span className="jq-seq-err" role="alert">⚠︎ {seqErr.msg}</span>}
                                    </div>
                                  )
                                })}
                              </div>
                            </li>
                          )
                        })}
                      </ol>
                    ) : (
                      // No segments for this ayah → the classic single-text view (first added language).
                      <p dir="auto">{shownEntry.text}</p>
                    )}
                    {(primaryEntry?.ttsError || faEntry?.ttsError) && (
                      <div className="jq-comment-err">⚠︎ {primaryEntry?.ttsError || faEntry?.ttsError}</div>
                    )}
                  </>
                ) : (
                  <div className="jq-transcript-empty">
                    <span>{shownEntry?.error ? `⚠︎ ${shownEntry.error}` : t('noTranscript')}</span>
                    {canDeviceSTT && <button className="jq-chip active" onClick={() => transcribe(a.n)}>📱 {t('transcribe')}</button>}
                  </div>
                )}
              </div>
            )}

            {openComments === a.n && (
              <Comments surah={surahNum} ayah={a.n} onCount={(c) => setCommentCounts((m) => ({ ...m, [a.n]: c }))} />
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

      <nav className="jq-surah-nav">
        {surahNum > 1 && <Link className="jq-chip" to={`/surah/${surahNum - 1}`}>‹ {t('prevSurah')}</Link>}
        {surahNum < 114 && <Link className="jq-chip" to={`/surah/${surahNum + 1}`}>{t('nextSurah')} ›</Link>}
      </nav>

      {playing && (
        /* Vertical progress rail: slim fixed strip on the right screen edge.
           Fill = played fraction top->bottom; drag/click anywhere seeks. */
        <div
          ref={railRef}
          className="jq-vrail"
          dir="ltr"
          role="slider"
          aria-label="seek"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={Math.round(prog.d || 0)}
          aria-valuenow={Math.round(Math.min(prog.t, prog.d || 0))}
          style={{ '--p': `${prog.d ? (Math.min(prog.t, prog.d) / prog.d) * 100 : 0}%` }}
          onPointerDown={(e) => {
            railDragRef.current = true
            try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* older browsers */ }
            railSeekAt(e.clientY)
          }}
          onPointerMove={(e) => { if (railDragRef.current) railSeekAt(e.clientY) }}
          onPointerUp={(e) => {
            railDragRef.current = false
            try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ok */ }
          }}
          onPointerCancel={() => { railDragRef.current = false }}
        >
          <div className="jq-vrail-fill" />
          <div className="jq-vrail-thumb" />
        </div>
      )}

      {playing && (
        <div className="jq-player" dir="ltr">
          <div className="jq-player-row">
            <button className="jq-player-toggle" aria-label={paused ? 'play' : 'pause'} onClick={togglePause}>
              {paused ? '▶' : '❚❚'}
            </button>
            <span className="jq-player-title">
              {playing.kind === 'listen' || playing.kind === 'listenseq'
                ? `${t('listen')} · ${listenLangLabel} · ${t('sentence')} ${
                    (playing.kind === 'listenseq'
                      ? playing.i
                      : active?.n === playing.n && active?.i != null ? active.i : 0) + 1
                  }/${trOf(playing.n, playing.kind === 'listenseq' ? playing.lang : primary)?.segments?.length || '?'} · ${t('ayah')} ${playing.n}`
                : playing.kind === 'basmala'
                  ? t('basmala')
                  : playing.kind === 'seg' || playing.kind === 'segfa'
                    ? `${t('sentence')} ${(playing.i ?? 0) + 1} · ${t('ayah')} ${playing.n}`
                    : `${playing.kind === 'tafsir' ? t('tafsir') : t('recitationPack')} · ${t('ayah')} ${playing.n}`}
            </span>
            <span className="jq-player-time">{fmtTime(prog.t)}</span>
            <button
              className="jq-player-speed"
              aria-label={t('speed')}
              onClick={() => { const S = [0.75, 1, 1.5]; setSpeed(S[(S.indexOf(speed) + 1) % S.length]) }}
            >
              {speed}X
            </button>
            <button className="jq-player-x" aria-label={t('stop')} onClick={stop}>✕</button>
          </div>
        </div>
      )}

      <audio
        ref={audioRef}
        onEnded={onEnded}
        onTimeUpdate={onTime}
        onLoadedMetadata={onTime}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        preload="none"
      />
    </div>
  )
}
