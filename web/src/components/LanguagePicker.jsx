import { LANGUAGES, useI18n } from '../lib/i18n.jsx'

export default function LanguagePicker({ onClose }) {
  const { lang, setLang, t } = useI18n()
  return (
    <div className="jq-sheet-overlay" onClick={onClose}>
      <div className="jq-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="jq-sheet-head">
          <span>{t('chooseLanguage')}</span>
          <button className="jq-sheet-close" onClick={onClose} aria-label={t('done')}>✕</button>
        </div>
        <ul className="jq-lang-list">
          {LANGUAGES.map((l) => (
            <li key={l.code}>
              <button
                className={`jq-lang-item${l.code === lang ? ' active' : ''}`}
                onClick={() => { setLang(l.code); onClose() }}
              >
                <span className="jq-lang-flag">{l.flag}</span>
                <span className="jq-lang-names">
                  <span className="jq-lang-native">{l.native}</span>
                  <span className="jq-lang-en">{l.name}</span>
                </span>
                {l.code === lang && <span className="jq-lang-check">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
