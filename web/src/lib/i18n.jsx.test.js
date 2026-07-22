// Characterization tests for the i18n catalog + resolver.
// These PIN current behavior. i18n.jsx is a .jsx module (react-swc handles the
// import); we only touch the PURE exports here: LANGUAGES, dirOf, and EN.
//
// The `t()` UI resolver lives INSIDE LanguageProvider as `(key) => EN[key] || key`
// and is only reachable through the useI18n() React hook. Driving the hook needs
// @testing-library/react, which lands in Phase 4 — so we SKIP the hook itself and
// characterize the EN dict + the `|| key` fallback logic directly, mirroring the
// exact one-liner the provider uses. No DOM needed → default node env.
import { describe, it, expect } from 'vitest'
import { LANGUAGES, dirOf, EN } from './i18n.jsx'

// The provider's resolver, reproduced verbatim from i18n.jsx line 387.
const t = (key) => EN[key] || key

describe('LANGUAGES catalog', () => {
  it('lists exactly the 14 catalog languages, in order', () => {
    expect(LANGUAGES).toHaveLength(14)
    expect(LANGUAGES.map((l) => l.code)).toEqual([
      'fa', 'en', 'ar', 'tr', 'ur', 'id', 'ms', 'fr', 'es', 'de', 'ru', 'hi', 'bn', 'sw',
    ])
  })

  it('every entry carries { code, native, name, flag, dir }', () => {
    for (const l of LANGUAGES) {
      expect(Object.keys(l).sort()).toEqual(['code', 'dir', 'flag', 'name', 'native'])
      expect(typeof l.native).toBe('string')
      expect(l.native.length).toBeGreaterThan(0)
      expect(['rtl', 'ltr']).toContain(l.dir)
    }
  })

  it('pins native names + display metadata for the leading entries', () => {
    expect(LANGUAGES[0]).toEqual({ code: 'fa', native: 'فارسی', name: 'Persian', flag: '🇮🇷', dir: 'rtl' })
    expect(LANGUAGES[1]).toEqual({ code: 'en', native: 'English', name: 'English', flag: '🇬🇧', dir: 'ltr' })
    expect(LANGUAGES[2]).toEqual({ code: 'ar', native: 'العربية', name: 'Arabic', flag: '🇸🇦', dir: 'rtl' })
    // Non-Latin natives round-tripped intact
    expect(LANGUAGES.find((l) => l.code === 'ur').native).toBe('اردو')
    expect(LANGUAGES.find((l) => l.code === 'ru').native).toBe('Русский')
    expect(LANGUAGES.find((l) => l.code === 'bn').native).toBe('বাংলা')
  })

  it('marks exactly fa/ar/ur as rtl; everything else ltr', () => {
    const rtl = LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code)
    expect(rtl).toEqual(['fa', 'ar', 'ur'])
  })
})

describe('dirOf', () => {
  it('returns rtl for the right-to-left scripts', () => {
    expect(dirOf('fa')).toBe('rtl')
    expect(dirOf('ar')).toBe('rtl')
    expect(dirOf('ur')).toBe('rtl')
  })
  it('returns ltr for known left-to-right languages', () => {
    expect(dirOf('en')).toBe('ltr')
    expect(dirOf('tr')).toBe('ltr')
    expect(dirOf('id')).toBe('ltr')
  })
  it('falls back to ltr for unknown / empty / undefined codes', () => {
    expect(dirOf('xx')).toBe('ltr')
    expect(dirOf('')).toBe('ltr')
    expect(dirOf(undefined)).toBe('ltr')
    // NOTE: pins current behavior — dirOf is a pure LANGUAGES lookup with a
    // `?.dir || 'ltr'` fallback; there is no separate rtl allow-list, so any code
    // absent from LANGUAGES (e.g. Hebrew 'he') is treated as ltr.
    expect(dirOf('he')).toBe('ltr')
  })
})

describe('EN dictionary', () => {
  it('pins a spread of source strings', () => {
    expect(EN.appName).toBe('Quran Hakim')
    expect(EN.stop).toBe('Stop')
    expect(EN.faTr).toBe('Persian')
    expect(EN.enTr).toBe('English')
    expect(EN.done).toBe('Done')
    expect(EN.play).toBe('Play')
    expect(EN.pause).toBe('Pause')
  })

  it('pins the last-writer-wins value for the DUPLICATED shareFailed key', () => {
    // NOTE: pins current (possibly-wrong) behavior — `shareFailed` is declared
    // twice in the EN object literal ('Share failed' then 'Could not share').
    // JS keeps the LAST definition, so the earlier 'Share failed' is unreachable.
    expect(EN.shareFailed).toBe('Could not share')
  })
})

describe('t() resolver — EN[key] || key', () => {
  it('resolves known keys to their English string', () => {
    expect(t('appName')).toBe('Quran Hakim')
    expect(t('signOut')).toBe('Sign out')
  })
  it('falls back to the key itself for unknown keys', () => {
    expect(t('totallyMadeUpKey')).toBe('totallyMadeUpKey')
    expect(t('')).toBe('')
  })
  it('is EN-only: it never consults FA/other dicts even for a fa-only concept', () => {
    // NOTE: pins current behavior — the provider hard-codes EN for UI strings
    // regardless of the selected content language, so any key missing from EN
    // returns the raw key, not a translation.
    expect(t('nonexistentUiString')).toBe('nonexistentUiString')
  })
})
