import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createGenerator } from './generate.mjs'
import { createRegistry } from '../providers/registry.mjs'
import { createArtifactStore } from '../store/artifact-store.mjs'
import { createLegacyBridge } from '../store/legacy-bridge.mjs'
import { createLayout } from '../store/layout.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The keep policy, proven end-to-end through the real generator + bridge:
// an existing legacy clip is served for $0 and never re-derived by a normal call,
// but an explicit override regenerates and the quality gate takes over.
const layout = createLayout({ SRV: '/srv', TRANSCRIPTS: '/srv/transcripts', TTS_DIR: '/srv/tafsir-tts', MEANING_DIR: '/srv/meaning-tts' })
const CLIP = 'tafsir/bazargan/fa/001_007'
const LEGACY = '/srv/tafsir-tts/bazargan/fa/001/001_007.mp3'

const call = (p) => p.synth('بسم الله', { lang: 'fa' })
const toArtifact = (r) => ({ files: { 'clip.mp3': r.mp3 }, provenance: { text: r.text } })
const fakeTts = (id, { model = 'v3' } = {}) => ({
  id: () => id, model,
  synth: vi.fn(async () => ({ mp3: `mp3-${id}`, text: 'بسم الله' })),
})

let root, store
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'jq-genleg-')) ; store = createArtifactStore({ root }) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const setup = ({ legacyAcceptance = 'keep', legacyPresent = true, chain = ['elevenlabs-tts'], register } = {}) => {
  const bridge = createLegacyBridge({
    store, layout, legacyAcceptance,
    fileExists: async (p) => legacyPresent && p === LEGACY,
  })
  const registry = createRegistry({ config: { defaults: { tts: chain } } })
  register(registry)
  return createGenerator({ registry, store: bridge })
}

describe('generate + legacy bridge (keep policy)', () => {
  it('KEEP + legacy present: a normal call serves legacy for $0 (provider NEVER called)', async () => {
    const p = fakeTts('elevenlabs-tts')
    const gen = setup({ register: (r) => r.register('tts', p) })
    const out = await gen.generate({ capability: 'tts', clipKey: CLIP, scope: { lang: 'fa' }, sourceSha: 's1', call, toArtifact })
    expect(out.cached).toBe(true)
    expect(out.source).toBe('legacy')
    expect(out.url).toBe('/tafsir-tts/bazargan/fa/001/001_007.mp3')
    expect(p.synth).not.toHaveBeenCalled() // <-- the money guarantee: no re-pay
  })

  it('KEEP + no legacy + no versioned: a normal miss generates as usual', async () => {
    const p = fakeTts('elevenlabs-tts')
    const gen = setup({ legacyPresent: false, register: (r) => r.register('tts', p) })
    const out = await gen.generate({ capability: 'tts', clipKey: CLIP, scope: { lang: 'fa' }, sourceSha: 's1', call, toArtifact })
    expect(out.cached).toBe(false)
    expect(out.provider).toBe('elevenlabs-tts')
    expect(p.synth).toHaveBeenCalledTimes(1)
  })

  it('REDERIVE + legacy present: the legacy file is ignored → it regenerates', async () => {
    const p = fakeTts('elevenlabs-tts')
    const gen = setup({ legacyAcceptance: 'rederive', register: (r) => r.register('tts', p) })
    const out = await gen.generate({ capability: 'tts', clipKey: CLIP, scope: { lang: 'fa' }, sourceSha: 's1', call, toArtifact })
    expect(out.cached).toBe(false)
    expect(p.synth).toHaveBeenCalledTimes(1)
  })

  it('KEEP + explicit override: regenerates, promotes, and thereafter the versioned current supersedes legacy', async () => {
    const p = fakeTts('elevenlabs-tts')
    const gen = setup({ register: (r) => r.register('tts', p) })
    // explicit override (a quality pass) bypasses the keep gate:
    const up = await gen.generate({ capability: 'tts', clipKey: CLIP, scope: { override: 'elevenlabs-tts', lang: 'fa' }, sourceSha: 's1', call, toArtifact })
    expect(up.cached).toBe(false)
    expect(up.provider).toBe('elevenlabs-tts')
    expect(up.promoted).toBe(true) // first versioned version becomes current
    expect(p.synth).toHaveBeenCalledTimes(1)

    // a subsequent NORMAL call now returns the versioned current, not legacy:
    const again = await gen.generate({ capability: 'tts', clipKey: CLIP, scope: { lang: 'fa' }, sourceSha: 's1', call, toArtifact })
    expect(again.cached).toBe(true)
    expect(again.source).toBe('versioned')
    expect(p.synth).toHaveBeenCalledTimes(1) // still not called again
  })
})
