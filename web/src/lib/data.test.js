// @vitest-environment jsdom
//
// Characterization tests for the AUDIO-URL RESOLVERS in data.js — the PROVIDER
// TOUCHPOINTS a later refactor phase will swap out. These PIN the exact URL
// shapes the current code produces for a given (surah, ayah[, reciter]) plus the
// reciter-selection/persistence state machine, so a change to any path or default
// fails loudly. They assert what the code DOES today, not what it "should" do.
//
// data.js keeps MODULE STATE — `_reciters`, and `_pattern` (captured from
// localStorage AT IMPORT TIME) — so each test re-imports a fresh copy via
// `freshData()` after clearing localStorage, giving deterministic isolation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mirror keys the app uses for the selected reciter + its cached URL pattern.
// (Not exported by data.js — pinned here as the literal offline/mirror keys.)
const RECITER_KEY = 'jq.reciter'
const RECITER_PATTERN_KEY = 'jq.reciterPattern'
const ALAFASY_PATTERN = '/reciters/Alafasy_128kbps/{c3}{v3}.mp3'
const HUSARY_PATTERN = '/reciters/Husary_128kbps/{c3}{v3}.mp3'

// Minimal stand-in for /public/data/reciters.json.
const RECITERS = [
  { id: 'alafasy', nameEn: 'Mishary Rashid Alafasy', pattern: ALAFASY_PATTERN },
  { id: 'husary', nameEn: 'Mahmoud Khalil Al-Husary', pattern: HUSARY_PATTERN },
]

// This jsdom build ships a non-functional `localStorage` (a bare object with no
// methods), so we install a real in-memory Storage before each test. data.js reads
// the global `localStorage` at call time, so reassigning it is picked up.
const makeStorage = () => {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    clear: () => { m.clear() },
    get length() { return m.size },
  }
}

// Fresh module instance (resets `_reciters`/`_pattern`). Set any localStorage the
// import-time capture should observe BEFORE calling this.
const freshData = async () => {
  vi.resetModules()
  return import('./data.js')
}

beforeEach(() => {
  globalThis.localStorage = makeStorage()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('AUDIO_BASE (provider prefix derived from the deploy base)', () => {
  it('collapses BASE_URL "/" to an empty prefix in this env (VITE_AUDIO_BASE unset)', async () => {
    const { AUDIO_BASE } = await freshData()
    // NOTE: pins current behavior — base "/" → replace(/\/$/,'') → '' (same-origin root).
    expect(AUDIO_BASE).toBe('')
  })
})

describe('recitation URL builder (the selected-reciter touchpoint)', () => {
  it('builds AUDIO_BASE + default (Alafasy) pattern with zero-padded {c3}{v3}', async () => {
    const { recitationAudioUrl, recitationPath } = await freshData()
    expect(recitationAudioUrl(1, 1)).toBe('/reciters/Alafasy_128kbps/001001.mp3')
    expect(recitationAudioUrl(2, 255)).toBe('/reciters/Alafasy_128kbps/002255.mp3')
    // recitationPath is the backend-relative form (also the offline cache key).
    expect(recitationPath(114, 6)).toBe('/reciters/Alafasy_128kbps/114006.mp3')
  })

  it('boots its pattern from the localStorage mirror; fillPattern honors {c3}{v3}{c}{v}', async () => {
    // The mirror is read at IMPORT time, so seed it before the fresh import.
    localStorage.setItem(RECITER_PATTERN_KEY, '/x/{c}-{v}/{c3}_{v3}.mp3')
    const { recitationPath } = await freshData()
    // {c3}->002, {v3}->005, {c}->2, {v}->5 (padded tokens replaced before bare ones)
    expect(recitationPath(2, 5)).toBe('/x/2-5/002_005.mp3')
  })
})

describe('tafsir + short-tafsir URL builders (fixed backend paths)', () => {
  it('tafsirAudioUrl → /tafsir/ssn/{c3}/{c3}_{v3}.mp3', async () => {
    const { tafsirAudioUrl, tafsirPath } = await freshData()
    expect(tafsirAudioUrl(1, 7)).toBe('/tafsir/ssn/001/001_007.mp3')
    expect(tafsirPath(1, 1)).toBe('/tafsir/ssn/001/001_001.mp3')
  })

  it('shortTafsirAudioUrl → /tafsir-short/{c3}/{c3}_{v3}.mp3', async () => {
    const { shortTafsirAudioUrl } = await freshData()
    expect(shortTafsirAudioUrl(114, 3)).toBe('/tafsir-short/114/114_003.mp3')
  })

  it('pad3 zero-pads to 3 but never truncates a longer number', async () => {
    const { tafsirPath } = await freshData()
    expect(tafsirPath(5, 9)).toBe('/tafsir/ssn/005/005_009.mp3')
    // NOTE: pins current behavior — pad3 uses padStart(3), so 4-digit inputs pass through.
    expect(tafsirPath(1000, 1)).toBe('/tafsir/ssn/1000/1000_001.mp3')
  })
})

describe('getReciter (default + persistence)', () => {
  it('defaults to "alafasy" when nothing is stored', async () => {
    const { getReciter } = await freshData()
    expect(getReciter()).toBe('alafasy')
  })
  it('returns the persisted id from localStorage', async () => {
    localStorage.setItem(RECITER_KEY, 'husary')
    const { getReciter } = await freshData()
    expect(getReciter()).toBe('husary')
  })
  it('falls back to the default when localStorage access throws (private mode)', async () => {
    // NOTE: pins the try/catch robustness branch — a throwing Storage yields the default.
    globalThis.localStorage = { getItem: () => { throw new Error('SecurityError') } }
    const { getReciter } = await freshData()
    expect(getReciter()).toBe('alafasy')
  })
})

describe('setReciter (selection persists; pattern needs the registry)', () => {
  it('persists the id but leaves the pattern at the default when the registry is NOT loaded', async () => {
    const { setReciter, getReciter, recitationAudioUrl } = await freshData()
    setReciter('husary')
    expect(getReciter()).toBe('husary')
    expect(localStorage.getItem(RECITER_KEY)).toBe('husary')
    // NOTE: pins current (possibly-surprising) behavior — without loadReciters(),
    // `_reciters` is null so the pattern falls back to Alafasy even though the
    // selected id is now "husary". The mirror is written as the default too.
    expect(recitationAudioUrl(3, 4)).toBe('/reciters/Alafasy_128kbps/003004.mp3')
    expect(localStorage.getItem(RECITER_PATTERN_KEY)).toBe(ALAFASY_PATTERN)
  })

  it('an unknown id after the registry loads also falls back to the Alafasy pattern', async () => {
    const { setReciter, recitationAudioUrl } = await freshData()
    setReciter('does-not-exist')
    expect(recitationAudioUrl(1, 1)).toBe('/reciters/Alafasy_128kbps/001001.mp3')
  })
})

describe('loadReciters (fetch stubbed: parse, cache, heal the mirror)', () => {
  it('fetches /data/reciters.json, returns the parsed registry, and caches it (one fetch)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => RECITERS }))
    global.fetch = fetchMock
    const { loadReciters } = await freshData()

    const first = await loadReciters()
    expect(first).toEqual(RECITERS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/data/reciters.json')

    const second = await loadReciters()
    expect(second).toBe(first) // cached — no second network call
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-applies the stored selection against the fresh registry (heals a stale mirror)', async () => {
    localStorage.setItem(RECITER_KEY, 'husary') // selected before the registry is known
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => RECITERS }))
    const { loadReciters, recitationAudioUrl } = await freshData()

    // Before load: pattern is still the default (Alafasy) mirror.
    expect(recitationAudioUrl(1, 1)).toBe('/reciters/Alafasy_128kbps/001001.mp3')

    await loadReciters()
    // After load: husary's pattern is applied and mirrored.
    expect(recitationAudioUrl(1, 1)).toBe('/reciters/Husary_128kbps/001001.mp3')
    expect(localStorage.getItem(RECITER_PATTERN_KEY)).toBe(HUSARY_PATTERN)
  })

  it('setReciter switches the live pattern once the registry is loaded', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => RECITERS }))
    const { loadReciters, setReciter, recitationAudioUrl } = await freshData()
    await loadReciters()

    setReciter('husary')
    expect(recitationAudioUrl(2, 5)).toBe('/reciters/Husary_128kbps/002005.mp3')
    expect(localStorage.getItem(RECITER_PATTERN_KEY)).toBe(HUSARY_PATTERN)
  })

  it('throws with the status code when the registry fetch is not ok', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    const { loadReciters } = await freshData()
    await expect(loadReciters()).rejects.toThrow('reciters 500')
  })
})
