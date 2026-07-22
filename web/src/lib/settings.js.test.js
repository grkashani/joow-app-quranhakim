// @vitest-environment jsdom
//
// Characterization tests for the reader settings model — the persisted config
// that drives per-ayah playback. These PIN the CURRENT behavior (defaults,
// first-run language inheritance, validation, persistence keys, and the single
// change-event the drawer live-updates from). If a later refactor changes a
// value here, that's a behavior change to make deliberately, not by accident.
//
// jsdom supplies window + CustomEvent + dispatchEvent (spied on to observe the
// READER_SETTINGS_EVENT emit). Its localStorage is inert on the opaque about:blank
// origin (no getItem/clear), so we stub a minimal in-memory Storage ourselves.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  MEANING_LANGS,
  READER_SETTINGS_EVENT,
  getMeaningLang,
  getReciteArabic,
  getTafsirMode,
  getReadAnnotations,
  getFarsiOriginal,
  getReaderSettings,
  setMeaningLang,
  setReciteArabic,
  setReadAnnotations,
  setTafsirMode,
  setFarsiOriginal,
} from './settings.js'

// Minimal in-memory localStorage the module can read/write through the bare
// `localStorage` global (jsdom's own is non-functional here).
const makeStore = () => {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    clear: () => { m.clear() },
  }
}

let dispatchSpy
beforeEach(() => {
  vi.stubGlobal('localStorage', makeStore())
  dispatchSpy = vi.spyOn(window, 'dispatchEvent')
})
afterEach(() => {
  dispatchSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('exported constants', () => {
  it('MEANING_LANGS are exactly the 8 languages present in the surah JSON, in order', () => {
    expect(MEANING_LANGS).toEqual(['en', 'fa', 'ar', 'tr', 'fr', 'es', 'de', 'ru'])
  })
  it('READER_SETTINGS_EVENT is the CustomEvent name the drawer listens on', () => {
    expect(READER_SETTINGS_EVENT).toBe('jq:reader-settings')
  })
})

describe('getMeaningLang — first-run inheritance + validation', () => {
  it('returns a stored value when it is one of MEANING_LANGS', () => {
    localStorage.setItem('jq.meaningLang', 'de')
    expect(getMeaningLang()).toBe('de')
  })
  it('first run (no stored lang): inherits the app content language jq.lang when offered', () => {
    localStorage.setItem('jq.lang', 'fa')
    expect(getMeaningLang()).toBe('fa')
  })
  it('first run: falls back to English when jq.lang is a language we do not offer', () => {
    localStorage.setItem('jq.lang', 'ja') // not in MEANING_LANGS
    expect(getMeaningLang()).toBe('en')
  })
  it('first run: falls back to English when there is no jq.lang at all', () => {
    expect(getMeaningLang()).toBe('en')
  })
  it('an INVALID stored meaningLang is ignored and inheritance runs again', () => {
    // NOTE: pins current behavior — a corrupt stored value falls through to the
    // jq.lang inheritance path rather than being returned verbatim.
    localStorage.setItem('jq.meaningLang', 'xx')
    localStorage.setItem('jq.lang', 'ru')
    expect(getMeaningLang()).toBe('ru')
  })
})

describe('getter DEFAULTS (nothing persisted yet)', () => {
  it('reciteArabic defaults ON', () => {
    expect(getReciteArabic()).toBe(true)
  })
  it('tafsirMode defaults to "off"', () => {
    expect(getTafsirMode()).toBe('off')
  })
  it('readAnnotations defaults ON', () => {
    expect(getReadAnnotations()).toBe(true)
  })
  it('farsiOriginal defaults OFF', () => {
    expect(getFarsiOriginal()).toBe(false)
  })
})

describe('getter parsing of persisted strings', () => {
  it('reciteArabic: "1" → true, "0" → false, garbage → false', () => {
    localStorage.setItem('jq.reciteArabic', '1'); expect(getReciteArabic()).toBe(true)
    localStorage.setItem('jq.reciteArabic', '0'); expect(getReciteArabic()).toBe(false)
    localStorage.setItem('jq.reciteArabic', 'yes'); expect(getReciteArabic()).toBe(false)
  })
  it('readAnnotations: "1" → true, "0" → false, garbage → false', () => {
    localStorage.setItem('jq.readAnnotations', '1'); expect(getReadAnnotations()).toBe(true)
    localStorage.setItem('jq.readAnnotations', '0'); expect(getReadAnnotations()).toBe(false)
    localStorage.setItem('jq.readAnnotations', 'nope'); expect(getReadAnnotations()).toBe(false)
  })
  it('farsiOriginal: only the literal "1" is truthy', () => {
    localStorage.setItem('jq.farsiOriginal', '1'); expect(getFarsiOriginal()).toBe(true)
    localStorage.setItem('jq.farsiOriginal', 'true'); expect(getFarsiOriginal()).toBe(false)
  })
  it('tafsirMode: only "short"/"long" survive, anything else → "off"', () => {
    localStorage.setItem('jq.tafsirMode', 'short'); expect(getTafsirMode()).toBe('short')
    localStorage.setItem('jq.tafsirMode', 'long'); expect(getTafsirMode()).toBe('long')
    localStorage.setItem('jq.tafsirMode', 'medium'); expect(getTafsirMode()).toBe('off')
  })
})

describe('getReaderSettings — the whole-object shape the event carries', () => {
  it('returns the default bag on a clean store', () => {
    expect(getReaderSettings()).toEqual({
      meaningLang: 'en',
      reciteArabic: true,
      tafsirMode: 'off',
      readAnnotations: true,
      farsiOriginal: false,
    })
  })
  it('reflects persisted values across every field', () => {
    localStorage.setItem('jq.meaningLang', 'tr')
    localStorage.setItem('jq.reciteArabic', '0')
    localStorage.setItem('jq.tafsirMode', 'long')
    localStorage.setItem('jq.readAnnotations', '0')
    localStorage.setItem('jq.farsiOriginal', '1')
    expect(getReaderSettings()).toEqual({
      meaningLang: 'tr',
      reciteArabic: false,
      tafsirMode: 'long',
      readAnnotations: false,
      farsiOriginal: true,
    })
  })
})

describe('setters — persist + emit READER_SETTINGS_EVENT + return value', () => {
  it('setMeaningLang(valid): persists, returns the lang, emits one event carrying the new bag', () => {
    const ret = setMeaningLang('fr')
    expect(ret).toBe('fr')
    expect(localStorage.getItem('jq.meaningLang')).toBe('fr')
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const ev = dispatchSpy.mock.calls[0][0]
    expect(ev.type).toBe(READER_SETTINGS_EVENT)
    expect(ev.detail).toEqual(getReaderSettings())
    expect(ev.detail.meaningLang).toBe('fr')
  })
  it('setMeaningLang(invalid): does NOT persist, does NOT emit, returns getMeaningLang()', () => {
    const ret = setMeaningLang('zz')
    expect(ret).toBe('en') // falls back to current getMeaningLang()
    expect(localStorage.getItem('jq.meaningLang')).toBeNull()
    expect(dispatchSpy).not.toHaveBeenCalled()
  })
  it('setReciteArabic: truthy → "1"/true, falsy → "0"/false, each emits', () => {
    expect(setReciteArabic(true)).toBe(true)
    expect(localStorage.getItem('jq.reciteArabic')).toBe('1')
    expect(setReciteArabic(0)).toBe(false) // NOTE: pins coercion — returns !!on
    expect(localStorage.getItem('jq.reciteArabic')).toBe('0')
    expect(dispatchSpy).toHaveBeenCalledTimes(2)
  })
  it('setReadAnnotations: persists "1"/"0", returns !!on, emits', () => {
    expect(setReadAnnotations('yep')).toBe(true) // truthy string coerces to true
    expect(localStorage.getItem('jq.readAnnotations')).toBe('1')
    expect(setReadAnnotations(false)).toBe(false)
    expect(localStorage.getItem('jq.readAnnotations')).toBe('0')
    expect(dispatchSpy).toHaveBeenCalledTimes(2)
  })
  it('setFarsiOriginal: persists "1"/"0", returns !!on, emits', () => {
    expect(setFarsiOriginal(true)).toBe(true)
    expect(localStorage.getItem('jq.farsiOriginal')).toBe('1')
    expect(setFarsiOriginal(null)).toBe(false)
    expect(localStorage.getItem('jq.farsiOriginal')).toBe('0')
    expect(dispatchSpy).toHaveBeenCalledTimes(2)
  })
  it('setTafsirMode: normalizes invalid input to "off", persists + emits + returns the normalized value', () => {
    expect(setTafsirMode('short')).toBe('short')
    expect(localStorage.getItem('jq.tafsirMode')).toBe('short')
    expect(setTafsirMode('bogus')).toBe('off') // NOTE: any non short/long → "off"
    expect(localStorage.getItem('jq.tafsirMode')).toBe('off')
    expect(dispatchSpy).toHaveBeenCalledTimes(2)
  })
})
