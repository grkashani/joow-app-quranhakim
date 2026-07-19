import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../lib/i18n.jsx'
import SignIn from '../components/SignIn.jsx'
import { getMe, signOut, cachedUser } from '../lib/auth.js'
import { isFramed, getShellUser, SHELL_USER_EVENT } from '../lib/framed.js'
import { fetchSummary } from '../lib/activity.js'
import { shareReport } from '../lib/report.js'

const PROFILE_KEY = 'jq.profile'
const LAST_KEY = 'jq.lastRead'

const fmtMins = (secs) => {
  const m = Math.round((secs || 0) / 60)
  return m >= 90 ? `${(m / 60).toFixed(1)}h` : `${m}m`
}
// Ayah count for the coverage strip: known surah lengths come from lastRead
// context or default to Fatiha's 7 (content exists for Fatiha today).
const surahAyahCount = (insights, lastRead) => {
  if (insights.surah === 1) return 7
  const fromAyahs = Math.max(0, ...Object.keys(insights.perAyah || {}).map(Number))
  return Math.max(fromAyahs, 7)
}

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}

export default function Profile() {
  const { t } = useI18n()
  const framed = isFramed()
  const [profile, setProfile] = useState(() => load(PROFILE_KEY, { name: t('guestUser') }))
  const [editing, setEditing] = useState(false)
  // Framed: identity comes from the JooW shell (the reader's own sign-in is
  // hidden). Standalone: the reader's own Apple/Google session.
  const [shellUser, setShellUser] = useState(() => getShellUser())
  const [account, setAccount] = useState(() => cachedUser()) // signed-in user or null
  const lastRead = load(LAST_KEY, null)
  // Reading insights (device-scoped, aggregated server-side from raw events).
  const [insights, setInsights] = useState(null)
  const [shareMsg, setShareMsg] = useState(null)
  useEffect(() => {
    fetchSummary(lastRead?.surah || 1).then(setInsights).catch(() => setInsights(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function handleShare() {
    setShareMsg('…')
    try {
      const name = (framed ? getShellUser()?.name : account?.name) || ''
      const r = await shareReport(insights, name)
      setShareMsg(r === 'shared-to-yquran' ? t('shareSent') : r === 'downloaded' ? t('shareSaved') : r === 'empty' ? t('shareEmpty') : t('shareDone'))
    } catch { setShareMsg(t('shareFailed')) }
    setTimeout(() => setShareMsg(null), 4000)
  }

  useEffect(() => localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)), [profile])
  // Re-validate the reader's own session on mount (standalone only — framed
  // identity is the shell's, so we never call the reader's /api/auth/me there).
  useEffect(() => { if (!framed) getMe().then((u) => setAccount(u)).catch(() => {}) }, [framed])
  useEffect(() => {
    if (!framed) return
    const on = (e) => setShellUser(e.detail || null)
    window.addEventListener(SHELL_USER_EVENT, on)
    return () => window.removeEventListener(SHELL_USER_EVENT, on)
  }, [framed])

  // In-shell, the host user replaces the reader's own account everywhere.
  const identity = framed ? shellUser : account
  const displayName = identity?.name || profile.name
  const initials = (displayName || '؟').trim().slice(0, 1)

  return (
    <div className="jq-shell jq-page">
      <h1 className="jq-page-title">{t('profileTitle')}</h1>

      <div className="jq-profile-card">
        {identity?.picture
          ? <img className="jq-avatar jq-avatar-img" src={identity.picture} alt="" referrerPolicy="no-referrer" />
          : <div className="jq-avatar">{initials}</div>}
        {identity ? (
          <div className="jq-account">
            <div className="jq-name">{identity.name} <span className="jq-comment-badge" title={t('verified')}>✔︎</span></div>
            {identity.email && <div className="jq-muted">{identity.email}</div>}
          </div>
        ) : editing ? (
          <input
            className="jq-search-input jq-name-input"
            value={profile.name}
            autoFocus
            onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => e.key === 'Enter' && setEditing(false)}
          />
        ) : (
          <button className="jq-name" onClick={() => setEditing(true)}>{profile.name} ✎</button>
        )}
      </div>

      {/* Account: standalone only. When framed the JooW shell owns identity, so
          the reader's own Apple/Google sign-in + sign-out are hidden. */}
      {!framed && (
      <div className="jq-profile-section">
        <div className="jq-section-title">{t('account')}</div>
        {account ? (
          <button className="jq-chip" onClick={async () => { await signOut(); setAccount(null) }}>
            {t('signOut')}
          </button>
        ) : (
          <SignIn onSignedIn={(u) => setAccount(u)} />
        )}
      </div>
      )}

      <div className="jq-profile-section">
        <div className="jq-section-title">{t('continueReading')}</div>
        {lastRead ? (
          <Link className="jq-surah-item" to={`/surah/${lastRead.surah}`}>
            <span className="jq-surah-num">{lastRead.surah}</span>
            <span className="jq-surah-names">
              <span className="jq-surah-fa">{lastRead.nameFa}</span>
              <span className="jq-surah-en">{t('lastReadSub')}</span>
            </span>
            <span className="jq-surah-count">›</span>
          </Link>
        ) : (
          <div className="jq-empty">{t('noRead')}</div>
        )}
      </div>

      {/* Reading insights: what you've heard, how often, and when. Derived
          server-side from the raw activity log, so richer reports can be added
          without touching this UI's data source. */}
      {(
        <div className="jq-profile-section">
          <div className="jq-insights-head">
            <div className="jq-section-title">{t('insightsTitle')}</div>
            {insights && insights.totals && (insights.totals.listens > 0 || insights.totals.readSecs > 0) && (
              <button className="jq-chip jq-share-report" onClick={handleShare} disabled={shareMsg === '…'}>
                {shareMsg && shareMsg !== '…' ? shareMsg : shareMsg === '…' ? '…' : `↗ ${t('shareReport')}`}
              </button>
            )}
          </div>
          {!insights || !insights.totals || (insights.totals.listens === 0 && !insights.totals.readSecs) ? (
            <div className="jq-empty">{t('insightsEmpty')}</div>
          ) : (
          <div className="jq-insights">
            <div className="jq-insight-stats">
              <div className="jq-insight-stat">
                <div className="jq-insight-num">{fmtMins(insights.totals.listenSecs)}</div>
                <div className="jq-insight-label">{t('insightListening')}</div>
              </div>
              <div className="jq-insight-stat">
                <div className="jq-insight-num">{insights.totals.listens}</div>
                <div className="jq-insight-label">{t('insightListens')}</div>
              </div>
              <div className="jq-insight-stat">
                <div className="jq-insight-num">{insights.totals.ayahsHeard}</div>
                <div className="jq-insight-label">{t('insightAyahs')}</div>
              </div>
              <div className="jq-insight-stat">
                <div className="jq-insight-num">{fmtMins(insights.totals.readSecs)}</div>
                <div className="jq-insight-label">{t('insightReading')}</div>
              </div>
            </div>

            {insights.surah && insights.perAyah && (
              <div className="jq-insight-block">
                <div className="jq-insight-sub">{t('insightCoverage')} · {t('surah')} {insights.surah}</div>
                <div className="jq-ayah-heat" dir="ltr">
                  {Array.from({ length: surahAyahCount(insights, lastRead) }, (_, i) => {
                    const a = insights.perAyah[i + 1]
                    const n = a ? a.listens : 0
                    return (
                      <div key={i} className={`jq-heat-cell${n ? '' : ' empty'}`} title={`${t('ayah')} ${i + 1}: ${n}×`}
                        style={n ? { opacity: Math.min(1, 0.35 + n * 0.13) } : undefined}>
                        <span className="jq-heat-num">{i + 1}</span>
                        <span className="jq-heat-count">{n ? `${n}×` : '—'}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {insights.hourHistogram && insights.hourHistogram.some((v) => v > 0) && (
              <div className="jq-insight-block">
                <div className="jq-insight-sub">{t('insightWhen')}</div>
                <div className="jq-hour-bars" dir="ltr">
                  {insights.hourHistogram.map((v, h) => {
                    const max = Math.max(...insights.hourHistogram, 1)
                    return <div key={h} className="jq-hour-bar" title={`${String(h).padStart(2, '0')}:00 · ${Math.round(v / 60)}m`}
                      style={{ height: `${6 + (v / max) * 34}px` }} />
                  })}
                </div>
                <div className="jq-hour-scale" dir="ltr"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
              </div>
            )}
          </div>
          )}
        </div>
      )}

      {/* Language choice lives in the Settings drawer ("Reading languages") — single source of truth. */}

      <div className="jq-profile-section">
        <div className="jq-section-title">{t('about')}</div>
        <div className="jq-about">
          <p>{t('aboutLine1')}</p>
          <p className="jq-muted">{t('aboutLine2')}</p>
        </div>
      </div>
    </div>
  )
}
