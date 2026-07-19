import { NavLink } from 'react-router-dom'
import { useI18n } from '../lib/i18n.jsx'

const I = {
  surah: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z" />
      <path d="M4 19a2 2 0 0 1 2-2h12" />
    </svg>
  ),
  word: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  ),
  gpt: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.6 3.9L17.5 8.5 13.6 10 12 14l-1.6-4L6.5 8.5l3.9-1.6z" />
      <path d="M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </svg>
  ),
  downloads: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  ),
  profile: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  ),
}

const TABS = [
  { to: '/surah', key: 'tabSurah', icon: I.surah },
  { to: '/word', key: 'tabWord', icon: I.word },
  { to: '/gpt', key: 'tabGpt', icon: I.gpt },
  { to: '/downloads', key: 'tabDownloads', icon: I.downloads },
  { to: '/profile', key: 'tabProfile', icon: I.profile },
]

export default function TabBar() {
  const { t } = useI18n()
  return (
    <nav className="jq-tabbar">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) => `jq-tab${isActive ? ' active' : ''}`}
        >
          <span className="jq-tab-icon">{tab.icon}</span>
          <span className="jq-tab-label">{t(tab.key)}</span>
        </NavLink>
      ))}
    </nav>
  )
}
