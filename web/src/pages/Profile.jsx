import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../lib/i18n.jsx'
import SignIn from '../components/SignIn.jsx'
import { getMe, signOut, cachedUser } from '../lib/auth.js'

const PROFILE_KEY = 'jq.profile'
const LAST_KEY = 'jq.lastRead'

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}

export default function Profile() {
  const { t } = useI18n()
  const [profile, setProfile] = useState(() => load(PROFILE_KEY, { name: t('guestUser') }))
  const [editing, setEditing] = useState(false)
  const [account, setAccount] = useState(() => cachedUser()) // signed-in user or null
  const lastRead = load(LAST_KEY, null)

  useEffect(() => localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)), [profile])
  // Re-validate the session on mount (token may be expired/revoked).
  useEffect(() => { getMe().then((u) => setAccount(u)).catch(() => {}) }, [])

  const displayName = account?.name || profile.name
  const initials = (displayName || '؟').trim().slice(0, 1)

  return (
    <div className="jq-shell jq-page">
      <h1 className="jq-page-title">{t('profileTitle')}</h1>

      <div className="jq-profile-card">
        {account?.picture
          ? <img className="jq-avatar jq-avatar-img" src={account.picture} alt="" referrerPolicy="no-referrer" />
          : <div className="jq-avatar">{initials}</div>}
        {account ? (
          <div className="jq-account">
            <div className="jq-name">{account.name} <span className="jq-comment-badge" title={t('verified')}>✔︎</span></div>
            {account.email && <div className="jq-muted">{account.email}</div>}
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
