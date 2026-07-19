import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { loadSurah, recitationAudioUrl, tafsirAudioUrl } from '../lib/data.js'
import { getDedicatedTafsir } from '../lib/tafsir.js'
import { getCached, setCached, getServerTranscript } from '../lib/transcribe.js'
import { getTtsUrl } from '../lib/tts.js'

// Strip ElevenLabs [audio-event] tags (transcription artifacts like [coughs],
// [laughs]) from DISPLAYED tafsir text. They stay in the stored text so the TTS
// voice can still perform them — only the on-screen text is cleaned.
const stripEventTags = (s) => String(s || '')
  .replace(/\[(?:coughs?|laughs?|laughter|chuckles?|sighs?|clears throat|throat clearing|pause|silence|music|applause|breath(?:es|ing)?|inhales?|exhales?|sniffs?|gasps?|hmm+|uh+|um+|er+)\]/gi, '')
  .replace(/\s{2,}/g, ' ')
  .trim()
import { getMeaningUrl, getShortTafsirUrl } from '../lib/meaning.js'
import { fetchCommentCounts } from '../lib/comments.js'
import Comments from '../components/Comments.jsx'
import { useI18n, LANGUAGES, dirOf } from '../lib/i18n.jsx'
import { getReaderSettings, READER_SETTINGS_EVENT } from '../lib/settings.js'

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
  const { num } = useParams()
  const surahNum = Number(num)
  const [surah, setSurah] = useState(null)
  const [error, setError] = useState(null)

  // Dedicated tafsir (Bazargan) — needed for the lecture TTS id and for the
  // tafsir transcript text shown under each ayah.
  const [tafsir, setTafsir] = useState(null)

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

  // Tafsir transcript text keyed `${lang}:${ayah}` -> { text } | { error } | { note }.
  const [tafsirText, setTafsirText] = useState({})
  const txOf = (n) => tafsirText[`${meaningLang}:${n}`]
  const inflight = useRef(new Set())

  // Comments: counts per ayah (0 = surah-level); which thread is open.
  const [commentCounts, setCommentCounts] = useState({})
  const [openComments, setOpenComments] = useState(null)

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

  // Playback speed (persisted; live-applied to the shared audio element).
  const [speed, setSpeed] = useState(() => Number(localStorage.getItem('jq.speed')) || 1)
  const speedRef = useRef(speed)
  useEffect(() => {
    speedRef.current = speed
    localStorage.setItem('jq.speed', String(speed))
    if (audioRef.current) audioRef.current.playbackRate = speed
  }, [speed])

  useEffect(() => { getDedicatedTafsir().then((tf) => setTafsir((cur) => cur || tf)) }, [])

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
  }, [surahNum])

  // ---- Tafsir transcript text (only when Tafsir is Short/Long) ----
  // One text per ayah in the meaning language: local cache -> server get-or-create.
  // 503/errors degrade to an honest note; they never block reading or playback.
  const fetchTafsirText = useCallback(async (n) => {
    if (!tafsir) return
    const k = `${meaningLang}:${n}`
    if (inflight.current.has(k)) return
    const cached = getCached(tafsir.id, meaningLang, surahNum, n)
    if (cached) { setTafsirText((m) => (m[k] ? m : { ...m, [k]: cached })); return }
    inflight.current.add(k)
    try {
      const r = await getServerTranscript(tafsir, surahNum, n, meaningLang)
      const e = { text: r.text, source: r.source }
      setCached(tafsir.id, meaningLang, surahNum, n, e)
      setTafsirText((m) => ({ ...m, [k]: e }))
    } catch (err) {
      setTafsirText((m) => ({ ...m, [k]: err?.status === 503 ? { note: t('ttsUnavailable') } : { error: String(err.message || err) } }))
    }
    inflight.current.delete(k)
  }, [tafsir, meaningLang, surahNum, t])

  useEffect(() => {
    if (!tafsir || !surah || tafsirMode === 'off') return
    for (const a of surah.ayahs) fetchTafsirText(a.n)
  }, [tafsir, surah, tafsirMode, meaningLang, fetchTafsirText])

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

  // Resolve one step to a playable URL. recite/long-fa are direct; meaning,
  // long-non-fa (lecture TTS) and short go through the 503-tolerant backend.
  const resolveUrl = useCallback(async (kind, n) => {
    const s = settingsRef.current
    if (kind === 'recite') return recitationAudioUrl(surahNum, n)
    if (kind === 'meaning') return getMeaningUrl(surahNum, n, s.meaningLang, s.readAnnotations)
    // tafsir
    if (s.tafsirMode === 'long') {
      // fa -> the original Persian lecture recording; other langs -> lecture TTS.
      if (s.meaningLang === 'fa') return tafsirAudioUrl(surahNum, n)
      if (!tafsir) { const e = new Error('tafsir not ready'); e.status = 503; throw e }
      return getTtsUrl(tafsir, surahNum, n, s.meaningLang)
    }
    return getShortTafsirUrl(surahNum, n, s.meaningLang) // short (may always 503 for now)
  }, [surahNum, tafsir])

  const stop = useCallback(() => {
    runIdRef.current++
    const el = audioRef.current
    if (el) { el.pause(); el.removeAttribute('src') }
    setCursor(null); cursorRef.current = null
    setBusy(false); setNote(null); setPaused(false)
  }, [])

  // Play step `si` of ayah `n`; drives the whole surah by advancing itself.
  const playStep = useCallback(async (n, si) => {
    const el = audioRef.current
    if (!el || !surah) return
    if (n > surah.ayahs.length) { stop(); return } // reached the end -> clean stop
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
      el.playbackRate = speedRef.current
      await el.play()
      if (myRun !== runIdRef.current) { el.pause(); return }
      setBusy(false)
    } catch (err) {
      if (myRun !== runIdRef.current) return // cancelled — swallow the abort
      setBusy(false)
      if (err?.status === 503) {
        // Not synthesized yet: honest note, skip this step, keep reading.
        setNote(t('ttsUnavailable'))
        playStep(n, si + 1)
      } else {
        // Genuine fetch/playback failure: pause the chain, offer a Retry.
        console.warn('[reader] step failed', { n, si, kind, err: String(err?.message || err) })
        setPlayErr({ n, si, msg: t('audioLoadError') })
      }
    }
  }, [surah, stepKinds, resolveUrl, stop, t])

  // onEnded must call the LATEST playStep closure (settings may have changed).
  const playStepRef = useRef(playStep)
  useEffect(() => { playStepRef.current = playStep }, [playStep])

  const onEnded = useCallback(() => {
    const c = cursorRef.current
    if (!c) return
    playStepRef.current(c.n, c.si + 1)
  }, [])

  // Start (or restart) the read-along from a given ayah.
  const startAt = useCallback((n) => {
    runIdRef.current++
    setPlayErr(null); setNote(null); setPaused(false)
    playStepRef.current(n, 0)
  }, [])

  // Header control: start the whole surah, or stop.
  const toggleSurah = useCallback(() => { if (cursor) stop(); else startAt(1) }, [cursor, stop, startAt])

  // Mini-player: pause / resume the current clip (does not leave the session).
  const togglePause = useCallback(() => {
    const el = audioRef.current
    if (!el || !el.src) return
    if (el.paused) el.play().catch(() => {}); else el.pause()
  }, [])

  // Retry a genuinely-failed step from exactly where it dropped.
  const retry = useCallback(() => {
    if (!playErr) return
    const { n, si } = playErr
    setPlayErr(null)
    runIdRef.current++
    playStepRef.current(n, si)
  }, [playErr])

  // Auto-scroll: bring the block currently being read into a comfortable position
  // whenever the ayah or step changes (smooth, only on change — naturally throttled).
  const activeRef = useRef(null)
  useEffect(() => {
    if (cursor) activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [cursor?.n, cursor?.kind])

  if (error) return <div className="jq-shell"><div className="jq-error">{error}</div></div>
  if (!surah) return <div className="jq-shell"><div className="jq-loading">{t('loading')}</div></div>

  const active = cursor != null
  const stepLabel = (kind) => (kind === 'recite' ? t('recitation') : kind === 'tafsir' ? t('tafsir') : t('meaning'))

  return (
    <div className={`jq-shell jq-reader${active ? ' has-player' : ''}`}>
      <header className="jq-reader-bar">
        <Link className="jq-back" to="/surah">‹ {t('back')}</Link>
        {/* THE single surah play/stop control. Reads through the whole surah using
            the current settings, auto-scrolling and highlighting as it goes. */}
        <button
          className={`jq-play jq-reader-play${active ? ' on' : ''}`}
          aria-label={active ? t('stop') : t('playFull')}
          aria-busy={busy}
          title={active ? t('stop') : t('playFull')}
          onClick={toggleSurah}
        >
          {active ? (busy ? '…' : '■') : '▶'}
        </button>
        <div className="jq-reader-title">
          <span className="jq-reader-fa">{t('surah')} {surah.nameFa}</span>
          <span className="jq-reader-en">{surah.nameEn} · {surah.ayahs.length} {t('ayahs')}</span>
        </div>
      </header>

      {/* Honest "audio being prepared" note, or a retryable load error — never a
          raw provider error, never a dead end. */}
      {note && <div className="jq-listen-note">{note}</div>}
      {playErr && (
        <div className="jq-listen-note jq-listen-err" role="alert">
          ⚠︎ {playErr.msg}
          <button className="jq-chip jq-retry" onClick={retry}>{t('retry')}</button>
        </div>
      )}

      {/* Static basmala line for surahs whose ayah 1 is not itself the basmala. */}
      {surahNum !== 1 && surahNum !== 9 && (
        <div className="jq-basmala jq-basmala-static">بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ</div>
      )}

      <ol className="jq-ayahs">
        {surah.ayahs.map((a) => {
          const isCur = cursor?.n === a.n
          const readKind = isCur ? cursor.kind : null
          const meaning = meaningOf(a, meaningLang)
          const tx = tafsirMode !== 'off' ? txOf(a.n) : null
          // Tapping the card starts playback FROM this ayah with current settings.
          return (
            <li
              key={a.n}
              className={`jq-ayah${isCur ? ' playing' : ''}`}
              onClick={() => startAt(a.n)}
            >
              <div className="jq-ayah-head">
                <span className="jq-ayah-num">{a.n}</span>
                <button
                  className={`jq-chip jq-cm-btn${openComments === a.n ? ' active' : ''}`}
                  aria-label={`${t('comments')} ${a.n}`}
                  onClick={(e) => { e.stopPropagation(); setOpenComments(openComments === a.n ? null : a.n) }}
                >
                  💬{commentCounts[a.n] ? ` ${commentCounts[a.n]}` : ''}
                </button>
              </div>

              <p
                ref={readKind === 'recite' ? activeRef : null}
                className={`jq-ar${readKind === 'recite' ? ' jq-reading' : ''}`}
                dir="rtl"
              >
                {a.ar} <span className="jq-ayah-marker">﴿{toArabicDigits(a.n)}﴾</span>
              </p>

              {/* The meaning in the CHOSEN language only (no stacked languages).
                  With "read insertions" ON we show the text as-is (the translator's
                  [..]/(..) runs muted); OFF we show the stripped text that matches
                  the `.noann` audio. */}
              {meaning && (
                <p
                  ref={readKind === 'meaning' ? activeRef : null}
                  className={`jq-meaning ${mDir === 'rtl' ? 'jq-fa' : 'jq-en'}${readKind === 'meaning' ? ' jq-reading' : ''}`}
                  dir={mDir}
                >
                  {readAnnotations ? renderMeaning(meaning) : meaningForDisplay(meaning, false)}
                  {' '}<span className="jq-tr-num">{meaningMarker(a.n, meaningLang)}</span>
                </p>
              )}

              {/* Tafsir text for this ayah (fa lecture text, or its translation). */}
              {tafsirMode !== 'off' && (
                <div
                  ref={readKind === 'tafsir' ? activeRef : null}
                  className={`jq-tafsir-panel${readKind === 'tafsir' ? ' jq-reading' : ''}`}
                  dir={mDir}
                >
                  {!tx ? (
                    <div className="jq-loading">{t('loading')}</div>
                  ) : tx.text ? (
                    <p className="jq-tafsir-text" dir={mDir}>{stripEventTags(tx.text)}</p>
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

      <nav className="jq-surah-nav">
        {surahNum > 1 && <Link className="jq-chip" to={`/surah/${surahNum - 1}`}>‹ {t('prevSurah')}</Link>}
        {surahNum < 114 && <Link className="jq-chip" to={`/surah/${surahNum + 1}`}>{t('nextSurah')} ›</Link>}
      </nav>

      {active && (
        <div className="jq-player" dir="ltr">
          <div className="jq-player-row">
            <button className="jq-player-toggle" aria-label={paused ? 'play' : 'pause'} onClick={togglePause}>
              {busy ? '…' : paused ? '▶' : '❚❚'}
            </button>
            <span className="jq-player-title">
              {stepLabel(cursor.kind)}
              {cursor.kind === 'meaning' || cursor.kind === 'tafsir' ? ` · ${LANGUAGES.find((l) => l.code === meaningLang)?.name || meaningLang.toUpperCase()}` : ''}
              {` · ${t('ayah')} ${cursor.n}`}
            </span>
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
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        preload="none"
      />
    </div>
  )
}
