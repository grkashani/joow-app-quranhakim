import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createGenerator } from './generate.mjs'
import { createRegistry } from '../providers/registry.mjs'
import { createArtifactStore } from '../store/artifact-store.mjs'
import { providerError } from '../providers/types.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CLIP = 'bazargan/fa/001_001'
const call = (p) => p.transcribe('/srv/tafsir/ssn/001/001_001.mp3', { lang: 'fa' })
const toArtifact = (result) => ({ files: { 'words.json': JSON.stringify(result.words) }, provenance: { text: result.text } })

// A fake TranscriptionProvider. `fail` (a providerError) makes it reject.
const fakeStt = (id, { model = 'm', fail = null } = {}) => ({
  id: () => id, model,
  transcribe: vi.fn(async () => {
    if (fail) throw fail
    return { text: `from-${id}`, words: [{ t: 'w', s: 0, e: 1 }] }
  }),
})

let root, store
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'jq-gen-')); store = createArtifactStore({ root }) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const genWith = (chainIds, register, budget) => {
  const registry = createRegistry({ config: { defaults: { stt: chainIds } } })
  register(registry)
  return { registry, gen: createGenerator({ registry, store, budget }) }
}

describe('generate — the lossless provider Job', () => {
  it('cache MISS → generates, stores a version, promotes, returns it', async () => {
    const p = fakeStt('whisper-local')
    const { gen } = genWith(['whisper-local'], (r) => r.register('stt', p))
    const out = await gen.generate({ capability: 'stt', clipKey: CLIP, scope: { lang: 'fa' }, sourceSha: 's1', call, toArtifact })
    expect(out.cached).toBe(false)
    expect(out.provider).toBe('whisper-local')
    expect(out.promoted).toBe(true)
    expect(p.transcribe).toHaveBeenCalledTimes(1)
    expect((await store.resolveCurrent(CLIP)).version.provider).toBe('whisper-local')
  })

  it('cache HIT → returns cached without calling the provider again', async () => {
    const p = fakeStt('whisper-local')
    const { gen } = genWith(['whisper-local'], (r) => r.register('stt', p))
    await gen.generate({ capability: 'stt', clipKey: CLIP, scope: { lang: 'fa' }, sourceSha: 's1', call, toArtifact })
    const again = await gen.generate({ capability: 'stt', clipKey: CLIP, scope: { lang: 'fa' }, sourceSha: 's1', call, toArtifact })
    expect(again.cached).toBe(true)
    expect(p.transcribe).toHaveBeenCalledTimes(1) // NOT called the second time
  })

  it('402 on the first provider → FALLS BACK to the next and records it', async () => {
    const fail = fakeStt('elevenlabs-scribe', { fail: providerError('past_due', 402) })
    const ok = fakeStt('whisper-local')
    const { gen } = genWith(['elevenlabs-scribe', 'whisper-local'], (r) => { r.register('stt', fail); r.register('stt', ok) })
    const out = await gen.generate({ capability: 'stt', clipKey: CLIP, scope: {}, sourceSha: 's1', call, toArtifact })
    expect(fail.transcribe).toHaveBeenCalledTimes(1)
    expect(ok.transcribe).toHaveBeenCalledTimes(1)
    expect(out.provider).toBe('whisper-local')
  })

  it('non-retryable (400) → THROWS, does not fall back (a real request bug surfaces)', async () => {
    const bad = fakeStt('elevenlabs-scribe', { fail: providerError('bad request', 400) })
    const ok = fakeStt('whisper-local')
    const { gen } = genWith(['elevenlabs-scribe', 'whisper-local'], (r) => { r.register('stt', bad); r.register('stt', ok) })
    await expect(gen.generate({ capability: 'stt', clipKey: CLIP, scope: {}, sourceSha: 's1', call, toArtifact }))
      .rejects.toMatchObject({ status: 400 })
    expect(ok.transcribe).not.toHaveBeenCalled()
  })

  it('clipKey DEDUP → two concurrent misses share ONE generation (no double-charge)', async () => {
    const p = fakeStt('whisper-local')
    const { gen } = genWith(['whisper-local'], (r) => r.register('stt', p))
    const args = { capability: 'stt', clipKey: CLIP, scope: {}, sourceSha: 's1', call, toArtifact }
    const [a, b] = await Promise.all([gen.generate(args), gen.generate(args)])
    expect(p.transcribe).toHaveBeenCalledTimes(1) // deduped
    expect(a.artifactHash).toBe(b.artifactHash)
  })

  it('QUALITY GATE end-to-end: a Whisper fallback re-run adds a version but never demotes a Scribe current', async () => {
    // 1) Scribe generates + becomes current (tier 3)
    const scribe = fakeStt('elevenlabs-scribe')
    const whisper = fakeStt('whisper-local')
    const registry = createRegistry({ config: { defaults: { stt: ['elevenlabs-scribe'] } } })
    registry.register('stt', scribe); registry.register('stt', whisper)
    const gen = createGenerator({ registry, store })
    await gen.generate({ capability: 'stt', clipKey: CLIP, scope: {}, sourceSha: 's1', call, toArtifact })
    expect((await store.resolveCurrent(CLIP)).version.provider).toBe('elevenlabs-scribe')

    // 2) Force a Whisper generation via override → new version, but the gate keeps Scribe current
    const out = await gen.generate({ capability: 'stt', clipKey: CLIP, scope: { override: 'whisper-local' }, sourceSha: 's1', call, toArtifact })
    expect(out.provider).toBe('whisper-local')
    expect(out.promoted).toBe(false) // gate refused to demote
    expect((await store.listVersions(CLIP)).length).toBe(2) // both retained
    expect((await store.resolveCurrent(CLIP)).version.provider).toBe('elevenlabs-scribe') // still the good one
  })

  it('budget rejection is retryable → falls back to the next provider', async () => {
    const p1 = fakeStt('elevenlabs-scribe')
    const p2 = fakeStt('whisper-local')
    const budget = { assert: vi.fn(async (id) => { if (id === 'elevenlabs-scribe') throw providerError('over budget', 429) }) }
    const { gen } = genWith(['elevenlabs-scribe', 'whisper-local'], (r) => { r.register('stt', p1); r.register('stt', p2) }, budget)
    const out = await gen.generate({ capability: 'stt', clipKey: CLIP, scope: {}, sourceSha: 's1', call, toArtifact })
    expect(p1.transcribe).not.toHaveBeenCalled() // budget blocked it before the call
    expect(out.provider).toBe('whisper-local')
  })
})
