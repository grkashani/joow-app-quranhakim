import { useI18n } from '../lib/i18n.jsx'

export default function TopBar({ onMenu }) {
  const { t } = useI18n()
  // The signed-in member's avatar is intentionally NOT surfaced here — the
  // identity lives in the Profile tab and the hamburger menu, so the header
  // stays clean (just the app title + menu).
  return (
    <header className="jq-topbar">
      <span className="jq-topbar-title">{t('appName')}</span>
      <button className="jq-hamburger" onClick={onMenu} aria-label={t('menu')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
    </header>
  )
}
