import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createArtifactStore } from './artifact-store.mjs'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

let root, store
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jq-store-'))
  store = createArtifactStore({ root })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const clip = 'bazargan/fa/001_001'
const prov = (provider, extra = {}) => ({ provider, model: 'm', sourceSha: 's1', createdAt: '2026-01-01', ...extra })

describe('put — atomic publish, never overwrite, provenance required', () => {
  it('rejects a put with no provenance.provider (no un-reprocessable artifacts)', async () => {
    await expect(store.put(clip, 'h1', { files: { 'x.txt': 'a' }, provenance: {} })).rejects.toThrow()
  })
  it('writes files + gen.json together and records a version', async () => {
    const v = await store.put(clip, 'h1', { files: { 'words.json': '{"w":[]}' }, provenance: prov('whisper-local') })
    expect(v.artifactHash).toBe('h1')
    expect(v.files).toEqual(expect.arrayContaining(['words.json', 'gen.json']))
    // gen.json exists next to the artifact — always re-processable
    const gen = JSON.parse(await readFile(path.join(store.ref(clip, 'h1').dir, 'gen.json'), 'utf8'))
    expect(gen.provider).toBe('whisper-local')
    expect(await store.has(clip, 'h1')).toBe(true)
  })
  it('is idempotent: a second put of the same hash returns the existing version', async () => {
    const a = await store.put(clip, 'h1', { files: { 'w.json': '1' }, provenance: prov('whisper-local') })
    const b = await store.put(clip, 'h1', { files: { 'w.json': '2' }, provenance: prov('whisper-local') })
    expect(b.artifactHash).toBe(a.artifactHash)
    expect(await readFile(path.join(store.ref(clip, 'h1').dir, 'w.json'), 'utf8')).toBe('1') // NOT overwritten
  })
  it('leaves no .staging dir behind after a successful publish', async () => {
    await store.put(clip, 'h1', { files: { 'w.json': '1' }, provenance: prov('whisper-local') })
    const entries = await readdir(path.join(root, clip))
    expect(entries.some((e) => e.includes('.staging'))).toBe(false)
  })
  it('holds MULTIPLE provider versions side by side (never overwrites)', async () => {
    await store.put(clip, 'whisper-h', { files: { 'w.json': 'W' }, provenance: prov('whisper-local') })
    await store.put(clip, 'scribe-h', { files: { 'w.json': 'S' }, provenance: prov('elevenlabs-scribe') })
    const vs = await store.listVersions(clip)
    expect(vs.map((v) => v.provider).sort()).toEqual(['elevenlabs-scribe', 'whisper-local'])
  })
})

describe('current pointer + quality gate (promote)', () => {
  it('resolveCurrent is null until something is promoted', async () => {
    await store.put(clip, 'h1', { files: {}, provenance: prov('whisper-local') })
    expect(await store.resolveCurrent(clip)).toBeNull()
  })
  it('promotes the first version, and resolveCurrent returns it', async () => {
    await store.put(clip, 'h1', { files: {}, provenance: prov('whisper-local') })
    const r = await store.promote(clip, 'h1')
    expect(r.promoted).toBe(true)
    expect((await store.resolveCurrent(clip)).artifactHash).toBe('h1')
  })
  it('QUALITY GATE: refuses to demote a higher-tier current to a lower-tier version', async () => {
    await store.put(clip, 'scribe-h', { files: {}, provenance: prov('elevenlabs-scribe') }) // tier 3
    await store.promote(clip, 'scribe-h')
    await store.put(clip, 'whisper-h', { files: {}, provenance: prov('whisper-local') })     // tier 1
    const r = await store.promote(clip, 'whisper-h') // a transient fallback tries to take over
    expect(r.promoted).toBe(false)
    expect((await store.resolveCurrent(clip)).artifactHash).toBe('scribe-h') // good clip retained
  })
  it('promotes an equal-or-higher tier (Whisper→Scribe upgrade)', async () => {
    await store.put(clip, 'whisper-h', { files: {}, provenance: prov('whisper-local') })
    await store.promote(clip, 'whisper-h')
    await store.put(clip, 'scribe-h', { files: {}, provenance: prov('elevenlabs-scribe') })
    expect((await store.promote(clip, 'scribe-h')).promoted).toBe(true)
    expect((await store.resolveCurrent(clip)).artifactHash).toBe('scribe-h')
  })
  it('force overrides the gate (explicit rollback / manual override)', async () => {
    await store.put(clip, 'scribe-h', { files: {}, provenance: prov('elevenlabs-scribe') })
    await store.promote(clip, 'scribe-h')
    await store.put(clip, 'whisper-h', { files: {}, provenance: prov('whisper-local') })
    expect((await store.promote(clip, 'whisper-h', { force: true })).promoted).toBe(true)
    expect((await store.resolveCurrent(clip)).artifactHash).toBe('whisper-h')
    // and we can roll back by flipping the pointer to the retained Scribe version
    await store.setCurrent(clip, 'scribe-h')
    expect((await store.resolveCurrent(clip)).artifactHash).toBe('scribe-h')
  })
  it('setCurrent throws for an unknown version', async () => {
    await expect(store.setCurrent(clip, 'nope')).rejects.toThrow()
  })
})
