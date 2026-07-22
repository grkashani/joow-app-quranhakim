import { useEffect, useRef, useState } from 'react'
import { fetchComments, postComment, uploadContrib, mediaSrc } from '../lib/comments.js'
import { useI18n } from '../lib/i18n.jsx'
import { isFramed, getShellUser, SHELL_USER_EVENT } from '../lib/framed.js'
import { cachedUser } from '../lib/auth.js'

// Prefer a name the user already typed here; else their profile name (if they set one).
function initialName() {
  const saved = (localStorage.getItem('jq.commentName') || '').trim()
  if (saved) return saved
  try {
    const p = JSON.parse(localStorage.getItem('jq.profile'))
    const n = (p?.name || '').trim()
    if (n && n !== 'Guest user' && n !== 'کاربر مهمان') return n
  } catch { /* none */ }
  return ''
}

function ago(iso, t) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 45) return t('justNow')
  const m = Math.round(s / 60); if (m < 60) return `${m}m`
  const h = Math.round(m / 60); if (h < 24) return `${h}h`
  const d = Math.round(h / 24); if (d < 30) return `${d}d`
  return new Date(iso).toLocaleDateString()
}

// Render one stored media attachment inline (image / audio / video / file).
function Media({ m }) {
  const src = mediaSrc(m.url)
  if (m.type === 'image') return <img className="jq-cmedia jq-cmedia-img" src={src} alt={m.name || ''} loading="lazy" />
  if (m.type === 'audio') return <audio className="jq-cmedia jq-cmedia-audio" src={src} controls preload="none" />
  if (m.type === 'video') return <video className="jq-cmedia jq-cmedia-video" src={src} controls preload="none" playsInline />
  return <a className="jq-cmedia jq-cmedia-file" href={src} target="_blank" rel="noopener noreferrer">📎 {m.name || 'file'}</a>
}

// A comments thread for a surah (ayah = 0) or a single ayah.
export default function Comments({ surah, ayah = 0, onCount }) {
  const { t } = useI18n()
  const [list, setList] = useState(null) // null = loading
  const [name, setName] = useState(initialName)
  const [text, setText] = useState('')
  // Draft attachments (uploaded refs) staged before the comment is posted.
  const [media, setMedia] = useState([])   // [{ id, url, type, mime, name, dur, bytes }]
  const [uploading, setUploading] = useState(false)
  const [recording, setRecording] = useState(false)
  const recRef = useRef(null)               // { mr, chunks, stream, t0 }
  const fileRef = useRef(null)
  // Known identity: the yQuran shell's member card (framed) or the reader's own
  // signed-in account (standalone). When present, the name field disappears.
  const framed = isFramed()
  const [shellUser, setShellUserS] = useState(() => getShellUser())
  useEffect(() => {
    if (!framed) return
    const on = (e) => setShellUserS(e.detail || null)
    window.addEventListener(SHELL_USER_EVENT, on)
    return () => window.removeEventListener(SHELL_USER_EVENT, on)
  }, [framed])
  const knownName = (framed ? shellUser?.name : cachedUser()?.name) || ''
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const taRef = useRef(null)

  useEffect(() => {
    let alive = true
    setList(null)
    fetchComments(surah, ayah)
      .then((c) => { if (alive) { setList(c); onCount?.(c.length) } })
      .catch(() => { if (alive) setList([]) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surah, ayah])

  // Upload picked files (image / audio / video / pdf), staging each ref.
  async function onFiles(files) {
    const arr = [...(files || [])].slice(0, 6 - media.length)
    if (!arr.length) return
    setUploading(true); setErr(null)
    try {
      for (const f of arr) {
        const ref = await uploadContrib(surah, ayah, f, { name: f.name })
        setMedia((m) => [...m, ref])
      }
    } catch { setErr(t('uploadError') || 'Upload failed') }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  // Record a voice note (MediaRecorder → upload on stop).
  async function toggleRecord() {
    if (recording) {
      try { recRef.current?.mr?.stop() } catch { /* already stopped */ }
      return
    }
    setErr(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = ['audio/mp4', 'audio/webm'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || ''
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const chunks = []
      recRef.current = { mr, stream, t0: Date.now() }
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
      mr.onstop = async () => {
        setRecording(false)
        stream.getTracks().forEach((tr) => tr.stop())
        const dur = (Date.now() - recRef.current.t0) / 1000
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' })
        if (blob.size < 400) return // empty
        setUploading(true)
        try {
          const ref = await uploadContrib(surah, ayah, blob, { name: `voice-${Math.round(dur)}s`, dur })
          setMedia((m) => [...m, ref])
        } catch { setErr(t('uploadError') || 'Upload failed') }
        setUploading(false)
      }
      mr.start()
      setRecording(true)
    } catch { setErr(t('micDenied') || 'Microphone unavailable') }
  }

  function removeMedia(i) { setMedia((m) => m.filter((_, j) => j !== i)) }

  async function submit(e) {
    e.preventDefault()
    const body = text.trim()
    if ((!body && media.length === 0) || busy || uploading || recording) return
    setBusy(true); setErr(null)
    try {
      const postName = (knownName || name).trim()
      const c = await postComment(surah, ayah, postName, body, media)
      if (!knownName && postName) localStorage.setItem('jq.commentName', postName)
      setList((l) => { const next = [...(l || []), c]; onCount?.(next.length); return next })
      setText(''); setMedia([])
      taRef.current?.focus()
    } catch { setErr(t('commentError')) }
    setBusy(false)
  }

  return (
    <div className="jq-comments">
      {list === null ? (
        <div className="jq-loading">{t('loading')}</div>
      ) : list.length === 0 ? (
        <div className="jq-comments-empty">{t('noComments')}</div>
      ) : (
        <ul className="jq-comment-list">
          {list.map((c) => (
            <li key={c.id} className="jq-comment">
              <div className="jq-comment-head">
                {c.picture && <img className="jq-comment-avatar" src={c.picture} alt="" referrerPolicy="no-referrer" />}
                <span className="jq-comment-name">{c.name || t('anonymous')}</span>
                {c.verified && <span className="jq-comment-badge" title={t('verified')}>✔︎</span>}
                <span className="jq-comment-time">{ago(c.at, t)}</span>
              </div>
              {c.text && <p className="jq-comment-text" dir="auto">{c.text}</p>}
              {Array.isArray(c.media) && c.media.length > 0 && (
                <div className="jq-cmedia-wrap">{c.media.map((m, i) => <Media key={m.url || i} m={m} />)}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      <form className="jq-comment-form" onSubmit={submit}>
        {knownName ? (
          <div className="jq-comment-as">{t('commentingAs')} <b>{knownName}</b></div>
        ) : (
          <input
            className="jq-comment-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('yourName')}
            maxLength={48}
            aria-label={t('yourName')}
          />
        )}
        <textarea
          ref={taRef}
          className="jq-comment-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('writeComment')}
          maxLength={2000}
          rows={2}
          dir="auto"
          aria-label={t('addComment')}
        />

        {/* Staged attachments — preview + remove before posting. */}
        {media.length > 0 && (
          <div className="jq-cmedia-drafts">
            {media.map((m, i) => (
              <span key={i} className={`jq-cdraft jq-cdraft-${m.type}`}>
                {m.type === 'image' ? '🖼' : m.type === 'audio' ? '🎙' : m.type === 'video' ? '🎬' : '📎'}
                <span className="jq-cdraft-name">{m.name || m.type}</span>
                <button type="button" className="jq-cdraft-x" onClick={() => removeMedia(i)} aria-label={t('remove') || 'Remove'}>✕</button>
              </span>
            ))}
          </div>
        )}

        {err && <div className="jq-comment-err">⚠︎ {err}</div>}

        <div className="jq-comment-actions">
          {/* Attach any media / file, and record a voice note. */}
          <input ref={fileRef} type="file" accept="image/*,audio/*,video/*,application/pdf" multiple
            style={{ display: 'none' }} onChange={(e) => onFiles(e.target.files)} />
          <button type="button" className="jq-chip jq-cm-attach" disabled={uploading || media.length >= 6}
            onClick={() => fileRef.current?.click()} title={t('attachMedia') || 'Attach photo / video / file'}>📎</button>
          <button type="button" className={`jq-chip jq-cm-rec${recording ? ' on' : ''}`} disabled={uploading}
            onClick={toggleRecord} title={recording ? (t('stopRecording') || 'Stop') : (t('recordVoice') || 'Record voice')}>
            {recording ? '■' : '🎙'}
          </button>
          {uploading && <span className="jq-cm-uploading">{t('uploading') || 'Uploading…'}</span>}
          <button className="jq-chip active jq-comment-post" type="submit"
            disabled={busy || uploading || recording || (!text.trim() && media.length === 0)}>
            {busy ? t('posting') : t('post')}
          </button>
        </div>
      </form>
    </div>
  )
}
