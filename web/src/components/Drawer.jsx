import { useEffect, useState } from 'react'
import { useI18n, LANGUAGES } from '../lib/i18n.jsx'
import {
  getTheme, getFont, setTheme, setFont,
  getMeaningLang, setMeaningLang, MEANING_LANGS,
  getReciteArabic, setReciteArabic,
  getTafsirMode, setTafsirMode,
  getReadAnnotations, setReadAnnotations,
} from '../lib/settings.js'
import { loadReciters, getReciter, setReciter } from '../lib/data.js'
import { isFramed, getShellUser, SHELL_USER_EVENT } from '../lib/framed.js'

// App language is fixed (English). The reader model settings below are the home
// of all content choice: ONE meaning language, whether Arabic recitation plays
// first, and the tafsir depth (off/short/long).
export default function Drawer({ open, onClose }) {
  const { t } = useI18n()
  // Framed: the JooW shell OWNS appearance (theme + language + direction), so
  // hide the reader's own theme + language pickers — the shell drives them.
  const framed = isFramed()
  const [theme, setThemeS] = useState(getTheme())
  const [font, setFontS] = useState(getFont())
  const [reciters, setReciters] = useState([])
  const [reciter, setReciterS] = useState(getReciter())
  const [meaningLang, setMeaningLangS] = useState(getMeaningLang)
  const [langOpen, setLangOpen] = useState(false)
  const [reciteArabic, setReciteArabicS] = useState(getReciteArabic)
  const [tafsirMode, setTafsirModeS] = useState(getTafsirMode)
  const [readAnnotations, setReadAnnotationsS] = useState(getReadAnnotations)
  // Framed: the signed-in member's identity (from the yQuran shell) — shown as a
  // small header here so the avatar lives in the menu instead of the top bar.
  const [shellUser, setShellUser] = useState(() => getShellUser())
  useEffect(() => {
    if (!framed) return
    const on = (e) => setShellUser(e.detail || null)
    window.addEventListener(SHELL_USER_EVENT, on)
    return () => window.removeEventListener(SHELL_USER_EVENT, on)
  }, [framed])

  useEffect(() => { loadReciters().then(setReciters).catch(() => setReciters([])) }, [])
  // Re-sync from storage each time the drawer opens (another tab/session may have changed it).
  useEffect(() => {
    if (!open) return
    setMeaningLangS(getMeaningLang()); setReciteArabicS(getReciteArabic()); setTafsirModeS(getTafsirMode())
    setReadAnnotationsS(getReadAnnotations())
  }, [open])

  const chooseTheme = (v) => { setTheme(v); setThemeS(v) }
  const chooseFont = (v) => { setFont(v); setFontS(v) }
  const chooseReciter = (id) => { setReciter(id); setReciterS(id) }
  const chooseMeaning = (c) => setMeaningLangS(setMeaningLang(c))
  const chooseRecite = (on) => setReciteArabicS(setReciteArabic(on))
  const chooseTafsir = (m) => setTafsirModeS(setTafsirMode(m))
  const chooseAnnotations = (on) => setReadAnnotationsS(setReadAnnotations(on))

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

        {shellUser && (
          <div className="jq-drawer-user" title={shellUser.name || ''}>
            {shellUser.picture
              ? <img className="jq-avatar jq-avatar-img jq-drawer-avatar" src={shellUser.picture} alt="" referrerPolicy="no-referrer" />
              : <span className="jq-avatar jq-drawer-avatar">{(shellUser.name || '').trim().slice(0, 1)}</span>}
            <span className="jq-drawer-user-name">{shellUser.name}</span>
          </div>
        )}

        {/* Theme: shown EVERYWHERE, including framed. The interim external
            embed doesn't drive the reader's theme, so hiding the toggle left
            embedded members stuck — if the full SDK bridge later owns
            appearance, its updates will simply overwrite this choice. */}
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

        {/* Meaning language: SINGLE select — the language the meaning is always
            shown and spoken in. Available EVERYWHERE, including framed inside
            the yQuran shell: this is a READER setting (which language is spoken
            and displayed), not shell-owned appearance — hiding it in the embed
            left members unable to switch languages at all. */}
        <div className="jq-drawer-section">
          <div className="jq-section-title">{t('meaningLanguage')}</div>
          {(() => {
            const cur = LANGUAGES.find((l) => l.code === meaningLang)
            return (
              <button
                type="button"
                className="jq-lang-row jq-lang-trigger"
                aria-haspopup="listbox"
                aria-expanded={langOpen}
                onClick={() => setLangOpen((v) => !v)}
              >
                <span className="jq-lang-native">{cur?.native || meaningLang}</span>
                {cur && cur.name !== cur.native && <span className="jq-lang-name">{cur.name}</span>}
                <span className="jq-lang-caret" aria-hidden="true">{langOpen ? '▲' : '▼'}</span>
              </button>
            )
          })()}
          {langOpen && (
            <div className="jq-lang-select" role="listbox" aria-label={t('meaningLanguage')}>
              {MEANING_LANGS.map((c) => {
                const m = LANGUAGES.find((l) => l.code === c)
                const on = meaningLang === c
                return (
                  <button
                    key={c}
                    className={`jq-lang-row${on ? ' active' : ''}`}
                    role="option"
                    aria-selected={on}
                    onClick={() => { chooseMeaning(c); setLangOpen(false) }}
                  >
                    <span className="jq-lang-check jq-lang-radio">{on ? '●' : ''}</span>
                    <span className="jq-lang-native">{m?.native || c}</span>
                    {m && m.name !== m.native && <span className="jq-lang-name">{m.name}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Recite Arabic first: play the Arabic recitation BEFORE the meaning. */}
        <div className="jq-drawer-section">
          <div className="jq-section-title">{t('reciteArabicFirst')}</div>
          <div className="jq-controls">
            <button className={`jq-chip${reciteArabic ? ' active' : ''}`} aria-pressed={reciteArabic} onClick={() => chooseRecite(true)}>{t('on')}</button>
            <button className={`jq-chip${!reciteArabic ? ' active' : ''}`} aria-pressed={!reciteArabic} onClick={() => chooseRecite(false)}>{t('off')}</button>
          </div>
        </div>

        {/* Tafsir: Off / Short / Long. The minimum experience is meaning only. */}
        <div className="jq-drawer-section">
          <div className="jq-section-title">{t('tafsir')}</div>
          <div className="jq-controls">
            <button className={`jq-chip${tafsirMode === 'off' ? ' active' : ''}`} aria-pressed={tafsirMode === 'off'} onClick={() => chooseTafsir('off')}>{t('tafsirOff')}</button>
            <button className={`jq-chip${tafsirMode === 'short' ? ' active' : ''}`} aria-pressed={tafsirMode === 'short'} onClick={() => chooseTafsir('short')}>{t('tafsirShort')}</button>
            <button className={`jq-chip${tafsirMode === 'long' ? ' active' : ''}`} aria-pressed={tafsirMode === 'long'} onClick={() => chooseTafsir('long')}>{t('tafsirLong')}</button>
          </div>
        </div>

        {/* Read translator insertions: include the clarifying [..]/(..) words the
            translator added, in both the spoken audio and the shown text. */}
        <div className="jq-drawer-section">
          <div className="jq-section-title">{t('annotations')}</div>
          <div className="jq-controls">
            <button className={`jq-chip${readAnnotations ? ' active' : ''}`} aria-pressed={readAnnotations} onClick={() => chooseAnnotations(true)}>{t('on')}</button>
            <button className={`jq-chip${!readAnnotations ? ' active' : ''}`} aria-pressed={!readAnnotations} onClick={() => chooseAnnotations(false)}>{t('off')}</button>
          </div>
          <div className="jq-section-hint jq-muted">{t('annotationsHint')}</div>
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
            <p className="jq-muted" dir="ltr">{`Build ${__APP_VERSION__}`}</p>
          </div>
        </div>
      </aside>
    </>
  )
}
