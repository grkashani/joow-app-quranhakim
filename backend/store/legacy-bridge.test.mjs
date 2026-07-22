import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createLegacyBridge } from './legacy-bridge.mjs'
import { createArtifactStore } from './artifact-store.mjs'
import { createLayout } from './layout.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const layout = createLayout({
  SRV: '/srv', TRANSCRIPTS: '/srv/transcripts', TTS_DIR: '/srv/tafsir-tts', MEANING_DIR: '/srv/meaning-tts',
})
const CLIP = 'tafsir/bazargan/fa/001_007'
const LEGACY = '/srv/tafsir-tts/bazargan/fa/001/001_007.mp3'
const URL = '/tafsir-tts/bazargan/fa/001/001_007.mp3'

// fileExists driven by a Set — no real /srv needed.
const existsFrom = (set) => async (p) => set.has(p)

let root, store
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'jq-bridge-')); store = createArtifactStore({ root }) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const putCurrent = async (hash, provider) => {
  await store.put(CLIP, hash, { files: { 'x.mp3': 'data' }, provenance: { provider } })
  await store.promote(CLIP, hash)
}

describe('legacy bridge — resolveAcceptable', () => {
  it('returns null when nothing exists (no versioned current, legacy absent)', async () => {
    const b = createLegacyBridge({ store, layout, fileExists: existsFrom(new Set()) })
    expect(await b.resolveAcceptable(CLIP)).toBe(null)
  })

  it('keep: an existing legacy flat file is acceptable → source:legacy, served url, no regen', async () => {
    const b = createLegacyBridge({ store, layout, fileExists: existsFrom(new Set([LEGACY])) })
    const r = await b.resolveAcceptable(CLIP)
    expect(r).toMatchObject({ source: 'legacy', clipKey: CLIP, url: URL, legacyPath: LEGACY })
    expect(r.version).toMatchObject({ provider: 'legacy' })
  })

  it('rederive: a legacy file is IGNORED (treated as absent → will regenerate)', async () => {
    const b = createLegacyBridge({ store, layout, fileExists: existsFrom(new Set([LEGACY])), legacyAcceptance: 'rederive' })
    expect(await b.resolveAcceptable(CLIP)).toBe(null)
  })

  it('a promoted versioned current WINS over a legacy file', async () => {
    await putCurrent('h1', 'elevenlabs-scribe')
    const b = createLegacyBridge({ store, layout, fileExists: existsFrom(new Set([LEGACY])) })
    const r = await b.resolveAcceptable(CLIP)
    expect(r.source).toBe('versioned')
    expect(r.artifactHash).toBe('h1')
    expect(r.url).toBe(URL) // still the flat served url
  })

  it('legacyExists() probes the exact legacy path derived from the clipKey', async () => {
    const b = createLegacyBridge({ store, layout, fileExists: existsFrom(new Set([LEGACY])) })
    expect(await b.legacyExists(CLIP)).toBe(true)
    expect(await b.legacyExists('tafsir/bazargan/fa/001_008')).toBe(false) // different ayah
  })
})

describe('legacy bridge — delegation + guards', () => {
  it('delegates has/put/promote/resolveCurrent/listVersions to the versioned store', async () => {
    const b = createLegacyBridge({ store, layout, fileExists: existsFrom(new Set()) })
    expect(await b.has(CLIP, 'h1')).toBe(false)
    await b.put(CLIP, 'h1', { files: { 'x.mp3': 'd' }, provenance: { provider: 'whisper-local' } })
    expect(await b.has(CLIP, 'h1')).toBe(true)
    expect((await b.listVersions(CLIP)).length).toBe(1)
    await b.promote(CLIP, 'h1')
    expect((await b.resolveCurrent(CLIP)).artifactHash).toBe('h1')
  })

  it('rejects an invalid legacyAcceptance', () => {
    expect(() => createLegacyBridge({ store, layout, legacyAcceptance: 'nuke' })).toThrow(/keep.*rederive/)
  })

  it('requires store + layout', () => {
    expect(() => createLegacyBridge({ layout })).toThrow(/store \+ layout/)
    expect(() => createLegacyBridge({ store })).toThrow(/store \+ layout/)
  })
})
