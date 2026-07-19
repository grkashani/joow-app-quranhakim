// Lightweight app settings (theme + font size), persisted and applied via
// data-attributes on <html> so CSS can react.
export function getTheme() { return localStorage.getItem('jq.theme') || 'light' }
export function getFont() { return localStorage.getItem('jq.font') || 'medium' }

export function applyTheme(t) { document.documentElement.setAttribute('data-theme', t) }
export function applyFont(f) { document.documentElement.setAttribute('data-font', f) }

export function setTheme(t) { localStorage.setItem('jq.theme', t); applyTheme(t) }
export function setFont(f) { localStorage.setItem('jq.font', f); applyFont(f) }

export function initSettings() { applyTheme(getTheme()); applyFont(getFont()) }

// ---- Reading languages ----
// ONE persisted list (jq.labLangs) is the single source of truth for language
// choice. It drives BOTH the translation/meaning lines under each ayah AND the
// Language Lab languages in the transcript panel. Chosen only in the Settings
// drawer. The tafsir source language (Persian) is always shown in the lab's
// sentence view regardless of this list — the tafsir IS Persian.
const LANGS_KEY = 'jq.labLangs'
const OLD_SHOW_KEY = 'jq.show' // legacy {fa,en} toggles — migrated then removed
// Every language with (or receiving) a full Fatiha transcript grid on the
// server — see /srv/transcripts/bazargan/<lang>/. Kept in i18n LANGUAGES order.
export const READING_LANG_CHOICES = ['fa', 'en', 'ar', 'tr', 'ur', 'id', 'ms', 'fr', 'es', 'de', 'ru', 'hi', 'bn', 'sw']
export const READING_LANGS_EVENT = 'jq:reading-langs'
const cleanLangs = (v) => (Array.isArray(v) ? v.filter((l) => READING_LANG_CHOICES.includes(l)) : [])

export function getReadingLangs() {
  let stored = null
  try { stored = JSON.parse(localStorage.getItem(LANGS_KEY)) } catch { /* corrupted */ }
  const showRaw = localStorage.getItem(OLD_SHOW_KEY)
  if (showRaw != null) {
    // One-time migration: old installs stored jq.show {fa,en} + a lab-only list
    // (which never contained fa). Merge both into the one list.
    let show = null
    try { show = JSON.parse(showRaw) } catch { /* corrupted */ }
    const langs = []
    if (show?.fa !== false) langs.push('fa')
    if (show?.en !== false) langs.push('en')
    for (const l of cleanLangs(stored)) if (!langs.includes(l)) langs.push(l)
    const out = langs.length ? langs : ['fa', 'en']
    localStorage.removeItem(OLD_SHOW_KEY)
    localStorage.setItem(LANGS_KEY, JSON.stringify(out))
    return out
  }
  const v = cleanLangs(stored)
  return v.length ? v : ['fa', 'en']
}

export function setReadingLangs(langs) {
  const v = cleanLangs(langs)
  const out = v.length ? v : ['fa', 'en'] // at least one language is required
  localStorage.setItem(LANGS_KEY, JSON.stringify(out))
  window.dispatchEvent(new CustomEvent(READING_LANGS_EVENT, { detail: out }))
  return out
}
