// Persistent bottom transport bar for the read-along reader.
//
// It owns NOTHING about playback logic — every button calls back into the
// Reader (which owns the shared <audio> element, the step/ayah sequence and the
// settings). The bar subscribes to the audio element ONLY to render the moving
// scrubber + clock, so the Reader never re-renders on `timeupdate`; this small
// leaf does.
//
// Layout is FIXED LTR in every language (owner: "even in farsi, audio player
// should be like in english") — transport controls always read
//   ⏮ previous ayah · ⏪ back 10s · ⏯ play/pause · ⏩ forward 10s · ⏭ next ayah
// left-to-right, elapsed time on the left of the scrubber, duration on the
// right, speed + ✕ at the far right. Only the title TEXT may be RTL (it wraps
// itself via unicode-bidi), never the bar.
import { useEffect, useState } from 'react'
import { useI18n } from '../lib/i18n.jsx'

// seconds -> m:ss (tabular). NaN/negative -> 0:00.
const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${m}:${String(r).padStart(2, '0')}`
}

export default function Player({
  audioRef,
  busy,
  paused,
  speed,
  onCycleSpeed,
  onTogglePause,
  onPrevAyah,
  onNextAyah,
  onSeekBy,
  onStop,
  canPrev,
  canNext,
  title,
  following,
  onRecenter,
}) {
  const { t } = useI18n()
  // Local clock — the ONLY state that ticks on `timeupdate`, kept in this leaf so
  // the Reader (and the whole surah) never re-renders while audio plays.
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onTime = () => setCur(el.currentTime || 0)
    const onMeta = () => setDur(isFinite(el.duration) ? el.duration : 0)
    const onEmpty = () => { setCur(0); setDur(0) }
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('durationchange', onMeta)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('emptied', onEmpty)
    onMeta(); onTime()
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('durationchange', onMeta)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('emptied', onEmpty)
    }
  }, [audioRef])

  const seek = (v) => {
    const el = audioRef.current
    if (el && isFinite(v)) { el.currentTime = v; setCur(v) }
  }

  return (
    <div className="jq-player" dir="ltr">
      <div className="jq-pl-scrub">
        <span className="jq-pl-time">{fmt(cur)}</span>
        <input
          className="jq-pl-range"
          type="range"
          min="0"
          max={dur || 0}
          step="0.01"
          value={Math.min(cur, dur || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!dur}
          aria-label={t('seek')}
        />
        <span className="jq-pl-time">{fmt(dur)}</span>
      </div>

      <div className="jq-pl-row">
        <button className="jq-pl-btn" onClick={onPrevAyah} disabled={!canPrev} aria-label={t('prevAyah')} title={t('prevAyah')}>⏮</button>
        <button className="jq-pl-btn" onClick={() => onSeekBy(-10)} aria-label={t('back10')} title={t('back10')}>⏪</button>
        <button className="jq-pl-btn jq-pl-play" onClick={onTogglePause} aria-label={paused ? t('play') : t('pause')} title={paused ? t('play') : t('pause')}>
          {busy ? '…' : paused ? '▶' : '❚❚'}
        </button>
        <button className="jq-pl-btn" onClick={() => onSeekBy(10)} aria-label={t('forward10')} title={t('forward10')}>⏩</button>
        <button className="jq-pl-btn" onClick={onNextAyah} disabled={!canNext} aria-label={t('nextAyah')} title={t('nextAyah')}>⏭</button>
        {/* Karaoke follow: lights up (and pulses) after a manual scroll — one tap
            glides back to the word being read. Follow also auto-resumes a few
            seconds after the last touch. */}
        <button
          className={`jq-pl-btn jq-pl-follow${following ? '' : ' off'}`}
          onClick={onRecenter}
          aria-label={t('followReading')}
          title={t('followReading')}
        >
          ◎
        </button>
        <span className="jq-pl-title">{title}</span>
        <button className="jq-pl-speed" onClick={onCycleSpeed} aria-label={t('speed')}>{speed}×</button>
        <button className="jq-pl-x" onClick={onStop} aria-label={t('stop')}>✕</button>
      </div>
    </div>
  )
}
