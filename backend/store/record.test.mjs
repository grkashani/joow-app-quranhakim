import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { recordGeneratedClip } from './record.mjs'
import { createArtifactStore } from './artifact-store.mjs'
import { createLayout } from './layout.mjs'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const layout = createLayout({ SRV: '/srv', TRANSCRIPTS: '/srv/transcripts', TTS_DIR: '/srv/tafsir-tts', MEANING_DIR: '/srv/meaning-tts' })

let root, store
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'jq-rec-')) ; store = createArtifactStore({ root }) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const clip = {
  kind: 'meaning', lang: 'en', s: 1, a: 1, ann: true,
  provider: 'elevenlabs-tts', model: 'eleven_v3', sourceText: 'In the name of God',
  sidecars: { 'words.json': JSON.stringify({ words: [{ w: 'In', s: 0, e: 0.3 }] }), 'gen.json': JSON.stringify({ credits: 12 }) },
  extra: { characterCost: 12 },
}

describe('recordGeneratedClip — lossless provenance without touching serving', () => {
  it('records a version pointing at the flat served URL (mp3 NOT duplicated)', async () => {
    const r = await recordGeneratedClip(store, layout, clip)
    expect(r.recorded).toBe(true)
    expect(r.clipKey).toBe('meaning/en/001_001')
    expect(r.promoted).toBe(true)

    // the version's gen.json provenance carries the served pointer, and only the
    // sidecars were stored (no mp3 bytes):
    const cur = await store.resolveCurrent('meaning/en/001_001')
    const gen = JSON.parse(await readFile(path.join(cur.dir, 'gen.json'), 'utf8'))
    expect(gen.servedUrl).toBe('/meaning-tts/en/001/001_001.mp3')
    expect(gen.provider).toBe('elevenlabs-tts')
    // the caller's 'gen.json' sidecar is preserved as 'source-gen.json' so it
    // doesn't clobber the store's own provenance gen.json:
    expect(cur.version.files.sort()).toEqual(['gen.json', 'source-gen.json', 'words.json'].sort())
    expect(cur.version.files).not.toContain('clip.mp3')
  })

  it('is idempotent: re-recording the same (provider,model,source) is a no-op', async () => {
    await recordGeneratedClip(store, layout, clip)
    const again = await recordGeneratedClip(store, layout, clip)
    expect(again.recorded).toBe(false)
    expect(again.reason).toBe('exists')
    expect((await store.listVersions('meaning/en/001_001')).length).toBe(1)
  })

  it('a different provider adds a COEXISTING version (lossless history)', async () => {
    await recordGeneratedClip(store, layout, clip)
    await recordGeneratedClip(store, layout, { ...clip, provider: 'whisper-local', sourceText: 'In the name of God' })
    expect((await store.listVersions('meaning/en/001_001')).length).toBe(2)
  })

  it('requires a provider', async () => {
    await expect(recordGeneratedClip(store, layout, { ...clip, provider: undefined })).rejects.toThrow(/provider is required/)
  })

  it('handles the STT/tafsir-seg coordinate shapes', async () => {
    const r1 = await recordGeneratedClip(store, layout, { kind: 'stt', id: 'bazargan', lang: 'fa', s: 1, a: 1, provider: 'elevenlabs-scribe', sidecars: { 'transcript.json': '{}' } })
    expect(r1.clipKey).toBe('stt/bazargan/fa/001_001')
    const r2 = await recordGeneratedClip(store, layout, { kind: 'tafsir-seg', id: 'bazargan', lang: 'fa', s: 1, a: 1, seg: 2, provider: 'elevenlabs-tts', sidecars: { 'gen.json': '{}' } })
    expect(r2.clipKey).toBe('tafsir/bazargan/fa/001_001/seg2')
  })
})
