// Compact icon controls for the shared-ayah embed header (one tidy row, no
// stacked dropdowns). Each control is an ICON with an invisible native <select>
// laid over it — tapping the icon opens the OS dropdown (ideal on mobile) while
// the header stays a single line.
//
//   🌐 language   📖 tafsir (off/short/long)   🎙️ reciter (None + voices)
//
// The reciter select doubles as the recitation on/off: "None" (top of the list)
// disables the Arabic recitation; picking any reciter enables it with that voice.
import { useI18n, LANGUAGES } from '../lib/i18n.jsx'

const NO_RECITE = '__none__'

// An icon that IS a native <select>: the glyph shows the control, the select is
// transparent on top so the platform picker still opens.
function IconSelect({ glyph, label, value, onChange, badge, dim, children }) {
  return (
    <label className={`jq-ic${dim ? ' dim' : ''}`} title={label} aria-label={label}>
      <span className="jq-ic-glyph" aria-hidden="true">{glyph}</span>
      {badge ? <span className="jq-ic-badge">{badge}</span> : null}
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {children}
      </select>
    </label>
  )
}

export default function EmbedControls({
  meaningLang, onLang, langs,
  tafsirMode, onTafsir,
  reciters, reciter, onReciter,
  reciteArabic, onReciteArabic,
}) {
  const { t } = useI18n()
  const tafBadge = tafsirMode === 'short' ? 'S' : tafsirMode === 'long' ? 'L' : null

  // The reciter picker reflects BOTH settings: value is the reciter when
  // recitation is on, or the "None" sentinel when it's off.
  const reciterValue = reciteArabic ? reciter : NO_RECITE
  const onReciterChange = (v) => {
    if (v === NO_RECITE) { onReciteArabic(false); return }
    if (!reciteArabic) onReciteArabic(true)
    onReciter(v)
  }

  return (
    <div className="jq-embed-icons">
      {/* Language — the viewer reads/hears the ayah in THEIR language (live swap). */}
      <IconSelect
        glyph="🌐" label={t('language') || 'Language'}
        value={meaningLang} onChange={onLang} badge={meaningLang.toUpperCase()}
      >
        {langs.map((code) => {
          const l = LANGUAGES.find((x) => x.code === code)
          return <option key={code} value={code}>{l ? l.native : code.toUpperCase()}</option>
        })}
      </IconSelect>

      {/* Tafsir length — off / short / long. Dim when off. */}
      <IconSelect
        glyph="📖" label={t('tafsir')} value={tafsirMode} onChange={onTafsir}
        badge={tafBadge} dim={tafsirMode === 'off'}
      >
        <option value="off">{t('tafsirOff')}</option>
        <option value="short">{t('tafsirShort')}</option>
        <option value="long">{t('tafsirLong')}</option>
      </IconSelect>

      {/* Reciter — "None" disables recitation; any voice enables it. Dim when None. */}
      <IconSelect
        glyph="🎙️" label={t('reciter')} value={reciterValue} onChange={onReciterChange}
        dim={!reciteArabic}
      >
        <option value={NO_RECITE}>{t('noRecitation')}</option>
        {reciters.map((r) => <option key={r.id} value={r.id}>{r.nameEn || r.nameFa || r.id}</option>)}
      </IconSelect>

    </div>
  )
}
