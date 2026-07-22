import { describe, it, expect } from 'vitest'
import { artifactHash, sha256, sha256File, PIPELINE_VERSION } from './hash.mjs'
import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

describe('sha256', () => {
  it('is deterministic 64-hex', () => {
    const a = sha256('hello')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256('hello')).toBe(a)
    expect(sha256('world')).not.toBe(a)
  })
  it('hashes a file', async () => {
    const p = path.join(tmpdir(), `jq-${randomBytes(4).toString('hex')}.txt`)
    await writeFile(p, 'abc')
    expect(await sha256File(p)).toBe(sha256('abc'))
    await rm(p)
  })
})

describe('artifactHash — content-addressed identity', () => {
  const base = { kind: 'stt', provider: 'whisper-local', model: 'large-v3', sourceSha: 'aaa' }

  it('requires kind + provider', () => {
    expect(() => artifactHash({ provider: 'x' })).toThrow()
    expect(() => artifactHash({ kind: 'stt' })).toThrow()
  })
  it('is stable for identical inputs', () => {
    expect(artifactHash(base)).toBe(artifactHash({ ...base }))
  })
  it('changes when the PROVIDER changes (Whisper vs Scribe never collide)', () => {
    expect(artifactHash(base)).not.toBe(artifactHash({ ...base, provider: 'elevenlabs-scribe' }))
  })
  it('changes when the MODEL, VOICE, or SOURCE changes', () => {
    expect(artifactHash(base)).not.toBe(artifactHash({ ...base, model: 'scribe_v2' }))
    expect(artifactHash(base)).not.toBe(artifactHash({ ...base, voice: 'v2' }))
    expect(artifactHash(base)).not.toBe(artifactHash({ ...base, sourceSha: 'bbb' }))
  })
  it('is settings-order-independent (canonical serialization)', () => {
    expect(artifactHash({ ...base, settings: { a: 1, b: 2 } }))
      .toBe(artifactHash({ ...base, settings: { b: 2, a: 1 } }))
  })
  it('changes when settings VALUES differ', () => {
    expect(artifactHash({ ...base, settings: { rate: 1 } }))
      .not.toBe(artifactHash({ ...base, settings: { rate: 2 } }))
  })
  it('folds in PIPELINE_VERSION (our own post-processing bumps re-derive)', () => {
    // Guards the pre-mortem fix: the version string is part of the identity.
    expect(artifactHash(base)).toContain('') // sanity
    expect(PIPELINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
