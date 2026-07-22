import { describe, it, expect } from 'vitest'
import { createLayout, pad3, fill, parseClipKey } from './layout.mjs'

// Characterization: these assertions pin the EXACT on-disk paths + public URLs
// the live server.mjs produces today. If a future refactor changes any of them,
// a test breaks — which is the point (the flat layout is load-bearing: nginx
// serves it and 20k clips already live at these paths).
const L = createLayout({
  SRV: '/srv',
  TRANSCRIPTS: '/srv/transcripts',
  TTS_DIR: '/srv/tafsir-tts',
  MEANING_DIR: '/srv/meaning-tts',
})

describe('pad3 / fill (exact server.mjs copies)', () => {
  it('pad3 zero-pads to 3', () => {
    expect(pad3(1)).toBe('001')
    expect(pad3(36)).toBe('036')
    expect(pad3(114)).toBe('114')
  })
  it('fill expands {c3}/{v3}/{c}/{v}', () => {
    expect(fill('/bazargan/{c3}/{c3}_{v3}.mp3', 2, 7)).toBe('/bazargan/002/002_007.mp3')
    expect(fill('audio/{c}-{v}.mp3', 2, 7)).toBe('audio/2-7.mp3')
  })
})

describe('legacy absolute paths match server.mjs', () => {
  it('transcript (stt) → /srv/transcripts/<id>/<lang>/<c3>/<c3>_<c3>.json', () => {
    expect(L.transcriptPath('bazargan', 'fa', 1, 1)).toBe('/srv/transcripts/bazargan/fa/001/001_001.json')
    expect(L.transcriptPath('ssn', 'ar', 2, 255)).toBe('/srv/transcripts/ssn/ar/002/002_255.json')
  })
  it('tafsir tts → /srv/tafsir-tts/<id>/<lang>/<c3>/<c3>_<c3>.mp3', () => {
    expect(L.tafsirPath('bazargan', 'fa', 1, 1)).toBe('/srv/tafsir-tts/bazargan/fa/001/001_001.mp3')
  })
  it('tafsir segment → …_<c3>.seg<idx>.mp3', () => {
    expect(L.tafsirSegPath('bazargan', 'fa', 1, 1, 0)).toBe('/srv/tafsir-tts/bazargan/fa/001/001_001.seg0.mp3')
    expect(L.tafsirSegPath('bazargan', 'fa', 1, 7, 3)).toBe('/srv/tafsir-tts/bazargan/fa/001/001_007.seg3.mp3')
  })
  it('meaning → /srv/meaning-tts/<lang>/<c3>/<c3>_<c3>[.noann].mp3', () => {
    expect(L.meaningPath('en', 1, 1, true)).toBe('/srv/meaning-tts/en/001/001_001.mp3')
    expect(L.meaningPath('en', 1, 1, false)).toBe('/srv/meaning-tts/en/001/001_001.noann.mp3')
  })
  it('localAudioPath fills the tafsir pattern under SRV, stripping a leading slash', () => {
    const t = { audio: { pattern: '/bazargan/{c3}/{c3}_{v3}.mp3' } }
    expect(L.localAudioPath(t, 2, 7)).toBe('/srv/bazargan/002/002_007.mp3')
  })
})

describe('public URLs match the server.mjs `rel` builders', () => {
  it('transcript served at /transcripts/…', () => {
    expect(L.transcriptUrl('bazargan', 'fa', 1, 1)).toBe('/transcripts/bazargan/fa/001/001_001.json')
  })
  it('tafsir + segment served at /tafsir-tts/…', () => {
    expect(L.tafsirUrl('bazargan', 'fa', 1, 1)).toBe('/tafsir-tts/bazargan/fa/001/001_001.mp3')
    expect(L.tafsirSegUrl('bazargan', 'fa', 1, 1, 2)).toBe('/tafsir-tts/bazargan/fa/001/001_001.seg2.mp3')
  })
  it('meaning served at /meaning-tts/… with the .noann variant', () => {
    expect(L.meaningUrl('en', 1, 1, true)).toBe('/meaning-tts/en/001/001_001.mp3')
    expect(L.meaningUrl('en', 1, 1, false)).toBe('/meaning-tts/en/001/001_001.noann.mp3')
  })
})

describe('sidecar naming (both written next to every .mp3)', () => {
  it('.mp3 → .words.json / .gen.json', () => {
    const abs = '/srv/tafsir-tts/bazargan/fa/001/001_001.mp3'
    expect(L.wordsSidecar(abs)).toBe('/srv/tafsir-tts/bazargan/fa/001/001_001.words.json')
    expect(L.genSidecar(abs)).toBe('/srv/tafsir-tts/bazargan/fa/001/001_001.gen.json')
  })
  it('only the final .mp3 is replaced', () => {
    expect(L.wordsSidecar('/x/001_001.seg2.mp3')).toBe('/x/001_001.seg2.words.json')
  })
})

describe('describe() — clipKey + legacyPath + url + sidecars for the store bridge', () => {
  it('stt: canonical key, legacy json path, no sidecars', () => {
    expect(L.describe({ kind: 'stt', id: 'bazargan', lang: 'fa', s: 1, a: 1 })).toEqual({
      clipKey: 'stt/bazargan/fa/001_001',
      legacyPath: '/srv/transcripts/bazargan/fa/001/001_001.json',
      url: '/transcripts/bazargan/fa/001/001_001.json',
      words: null, gen: null,
    })
  })
  it('tafsir: key + mp3 legacy path + both sidecars', () => {
    expect(L.describe({ kind: 'tafsir', id: 'bazargan', lang: 'fa', s: 1, a: 7 })).toEqual({
      clipKey: 'tafsir/bazargan/fa/001_007',
      legacyPath: '/srv/tafsir-tts/bazargan/fa/001/001_007.mp3',
      url: '/tafsir-tts/bazargan/fa/001/001_007.mp3',
      words: '/srv/tafsir-tts/bazargan/fa/001/001_007.words.json',
      gen: '/srv/tafsir-tts/bazargan/fa/001/001_007.gen.json',
    })
  })
  it('tafsir-seg: seg suffix in both the key and the path', () => {
    const r = L.describe({ kind: 'tafsir-seg', id: 'bazargan', lang: 'fa', s: 1, a: 1, seg: 3 })
    expect(r.clipKey).toBe('tafsir/bazargan/fa/001_001/seg3')
    expect(r.legacyPath).toBe('/srv/tafsir-tts/bazargan/fa/001/001_001.seg3.mp3')
    expect(r.url).toBe('/tafsir-tts/bazargan/fa/001/001_001.seg3.mp3')
  })
  it('meaning: ann vs noann diverge in key, path and url', () => {
    const ann = L.describe({ kind: 'meaning', lang: 'en', s: 1, a: 1, ann: true })
    const noann = L.describe({ kind: 'meaning', lang: 'en', s: 1, a: 1, ann: false })
    expect(ann.clipKey).toBe('meaning/en/001_001')
    expect(noann.clipKey).toBe('meaning/en/001_001/noann')
    expect(ann.legacyPath).toBe('/srv/meaning-tts/en/001/001_001.mp3')
    expect(noann.legacyPath).toBe('/srv/meaning-tts/en/001/001_001.noann.mp3')
    expect(noann.url).toBe('/meaning-tts/en/001/001_001.noann.mp3')
  })
  it('rejects an unknown kind', () => {
    expect(() => L.describe({ kind: 'video', lang: 'en', s: 1, a: 1 })).toThrow(/unknown kind/)
  })
})

describe('parseClipKey — inverse of describe().clipKey', () => {
  it('parses each kind back to its descriptor', () => {
    expect(parseClipKey('stt/bazargan/fa/001_001')).toEqual({ kind: 'stt', id: 'bazargan', lang: 'fa', s: 1, a: 1 })
    expect(parseClipKey('tafsir/bazargan/fa/001_007')).toEqual({ kind: 'tafsir', id: 'bazargan', lang: 'fa', s: 1, a: 7 })
    expect(parseClipKey('tafsir/bazargan/fa/001_001/seg3')).toEqual({ kind: 'tafsir-seg', id: 'bazargan', lang: 'fa', s: 1, a: 1, seg: 3 })
    expect(parseClipKey('meaning/en/001_001')).toEqual({ kind: 'meaning', lang: 'en', s: 1, a: 1, ann: true })
    expect(parseClipKey('meaning/en/001_001/noann')).toEqual({ kind: 'meaning', lang: 'en', s: 1, a: 1, ann: false })
  })
  it('tolerates ids with hyphens', () => {
    expect(parseClipKey('tafsir/bazargan-short/ar/114_006')).toEqual({ kind: 'tafsir', id: 'bazargan-short', lang: 'ar', s: 114, a: 6 })
  })
  it('rejects an unrecognised key', () => {
    expect(() => parseClipKey('video/en/001_001')).toThrow(/unrecognised/)
  })
  it('ROUND-TRIPS: describe(parseClipKey(k)).clipKey === k', () => {
    const keys = [
      'stt/bazargan/fa/001_001',
      'tafsir/bazargan/fa/001_007',
      'tafsir/bazargan-short/ar/114_006/seg2',
      'meaning/en/002_255',
      'meaning/fa/001_001/noann',
    ]
    for (const k of keys) {
      expect(L.describe(L.parseClipKey(k)).clipKey).toBe(k)
    }
  })
})

describe('dir overrides flow through (env-parity)', () => {
  it('a custom TTS_DIR changes both the path and the url prefix together', () => {
    const L2 = createLayout({ TTS_DIR: '/mnt/cache/tts' })
    expect(L2.tafsirPath('b', 'fa', 1, 1)).toBe('/mnt/cache/tts/b/fa/001/001_001.mp3')
    expect(L2.tafsirUrl('b', 'fa', 1, 1)).toBe('/tts/b/fa/001/001_001.mp3') // prefix = basename
  })
})
