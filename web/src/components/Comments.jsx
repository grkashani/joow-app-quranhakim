import { useEffect, useRef, useState } from 'react'
import { fetchComments, postComment } from '../lib/comments.js'
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

// A comments thread for a surah (ayah = 0) or a single ayah.
export default function Comments({ surah, ayah = 0, onCount }) {
  const { t } = useI18n()
  const [list, setList] = useState(null) // null = loading
  const [name, setName] = useState(initialName)
  const [text, setText] = useState('')
  // Known identity: the yQuran shell's member card (framed) or the reader's own
  // signed-in account (standalone). When present, the name field disappears and
  // comments attribute automatically.
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

  async function submit(e) {
    e.preventDefault()
    const body = text.trim()
    if (!body || busy) return
    setBusy(true); setErr(null)
    try {
      const postName = (knownName || name).trim()
      const c = await postComment(surah, ayah, postName, body)
      if (!knownName) localStorage.setItem('jq.commentName', postName)
      setList((l) => { const next = [...(l || []), c]; onCount?.(next.length); return next })
      setText('')
      taRef.current?.focus()
    } catch (e2) {
      setErr(t('commentError'))
    }
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
              <p className="jq-comment-text" dir="auto">{c.text}</p>
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
        {err && <div className="jq-comment-err">⚠︎ {err}</div>}
        <button className="jq-chip active jq-comment-post" type="submit" disabled={busy || !text.trim()}>
          {busy ? t('posting') : t('post')}
        </button>
      </form>
    </div>
  )
}
