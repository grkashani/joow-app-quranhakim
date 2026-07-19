import { useEffect, useState } from 'react'
import { useI18n, LANGUAGES } from '../lib/i18n.jsx'
import { getTheme, getFont, setTheme, setFont, getReadingLangs, setReadingLangs, READING_LANG_CHOICES } from '../lib/settings.js'
import { loadReciters, getReciter, setReciter } from '../lib/data.js'

// App language is fixed (English) — no language setting here. "Reading languages"
// below is the SINGLE home of content-language choice: one multi-select list that
// drives both the translation lines under each ayah and the Language Lab.
export default function Drawer({ open, onClose }) {
  const { t } = useI18n()
  const [theme, setThemeS] = useState(getTheme())
  const [font, setFontS] = useState(getFont())
  const [reciters, setReciters] = useState([])
  const [reciter, setReciterS] = useState(getReciter())
  const [readingLangs, setReadingLangsS] = useState(getReadingLangs)

  useEffect(() => { loadReciters().then(setReciters).catch(() => setReciters([])) }, [])
  useEffect(() => { if (open) setReadingLangsS(getReadingLangs()) }, [open])

  const chooseTheme = (v) => { setTheme(v); setThemeS(v) }
  const chooseFont = (v) => { setFont(v); setFontS(v) }
  const chooseReciter = (id) => { setReciter(id); setReciterS(id) }
  const toggleLang = (c) => {
    const next = readingLangs.includes(c) ? readingLangs.filter((x) => x !== c) : [...readingLangs, c]
    if (!next.length) return // at least one language stays selected
    setReadingLangsS(setReadingLangs(next))
  }

  async function share() {
    try {
      if (navigator.share) await navigator.share({ title: t('appName'), url: location.origin })
    } catch { /* cancelled */ }
  }

  return (
    <>
      <div className={`jq-drawer-overlay${open ? ' open' : ''}`} onClick={onClose} />
      <aside className={`jq-drawer${open ? ' open' : ''}`}>
        <div className="jq-drawer-head">
          <span className="jq-drawer-title">{t('menu')}</span>
          <button className="jq-sheet-close" onClick={onClose} aria-label={t('done')}>✕</button>
        </div>

        <div className="jq-drawer-section">
          <div className="jq-section-title">{t('theme')}</div>
          <div className="jq-controls">
            <button className={`jq-chip${theme === 'light' ? ' active' : ''}`} onClick={() => chooseTheme('light')}>☀︎ {t('themeLight')}</button>
            <button className={`jq-chip${theme === 'dark' ? ' active' : ''}`} onClick={() => chooseTheme('dark')}>☾ {t('themeDark')}</button>
          </div>
        </div>

        <div className="jq-drawer-section">
          <div className="jq-section-title">{t('fontSize')}</div>
          <div className="jq-controls">
            <button className={`jq-chip${font === 'small' ? ' active' : ''}`} onClick={() => chooseFont('small')}>{t('fontSmall')}</button>
            <button className={`jq-chip${font === 'medium' ? ' active' : ''}`} onClick={() => chooseFont('medium')}>{t('fontMedium')}</button>
            <button className={`jq-chip${font === 'large' ? ' active' : ''}`} onClick={() => chooseFont('large')}>{t('fontLarge')}</button>
          </div>
        </div>

        <div className="jq-drawer-section">
          <div className="jq-section-title">{t('readingLanguages')}</div>
          <div className="jq-lang-select">
            {READING_LANG_CHOICES.map((c) => {
              const m = LANGUAGES.find((l) => l.code === c)
              const on = readingLangs.includes(c)
              return (
                <button
                  key={c}
                  className={`jq-lang-row${on ? ' active' : ''}`}
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggleLang(c)}
                >
                  <span className="jq-lang-check">{on ? '✓' : ''}</span>
                  <span className="jq-lang-native">{m?.native}</span>
                  {m && m.name !== m.native && <span className="jq-lang-name">{m.name}</span>}
                </button>
              )
            })}
          </div>
        </div>

        <div className="jq-drawer-section">
          <div className="jq-section-title">{t('reciter')}</div>
          {/* Shell stays English: nameEn first, the reciter's own (Arabic/Persian) name after it. */}
          <select
            className="jq-select jq-reciter-select"
            value={reciter}
            onChange={(e) => chooseReciter(e.target.value)}
            aria-label={t('reciter')}
          >
            {(reciters.length ? reciters : [{ id: reciter, nameEn: 'Default (Quran Hakim)', nameFa: '' }]).map((r) => (
              <option key={r.id} value={r.id}>{r.nameEn}{r.nameFa ? ` — ${r.nameFa}` : ''}</option>
            ))}
          </select>
        </div>

        <button className="jq-drawer-row" onClick={share}>
          <span className="jq-drawer-row-label">↗ {t('share')}</span>
        </button>

        <div className="jq-drawer-section">
          <div className="jq-section-title">{t('about')}</div>
          <div className="jq-about">
            <p>{t('aboutLine1')}</p>
            <p className="jq-muted">{t('aboutLine2')}</p>
          </div>
        </div>
      </aside>
    </>
  )
}
