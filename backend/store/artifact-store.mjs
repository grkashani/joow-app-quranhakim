// Content-addressed, versioned, never-overwrite artifact store.
//
// This is the spine of "always upgradeable, never lost". Each generated clip
// (a transcript, a TTS mp3 + its word-timing sidecar) is stored UNDER its
// content hash, so a better provider or a pipeline improvement writes a NEW
// version alongside the old — never on top of it. A per-clip manifest lists
// every version with full provenance and a single `current` pointer; promoting
// an upgrade is an atomic pointer flip, and rolling back is flipping it back.
//
// Two invariants from the pre-mortem are baked in here:
//  1. ATOMIC PUBLISH — a version's files + provenance are staged in a tmp dir
//     and published with ONE rename, so no exposed artifact ever lacks its
//     provenance (which is what makes it re-processable). Never a partial write.
//  2. QUALITY GATE — put() only ADDS a version; promotion is separate and, by
//     default, refuses to replace a higher-tier current with a lower-tier one.
//     A transient fallback to a weaker provider can't silently demote a good clip.
import { mkdir, writeFile, readFile, rename, rm, access } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const MANIFEST = 'clip.json'
const exists = (p) => access(p).then(() => true, () => false)

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
  await writeFile(tmp, data)
  await rename(tmp, file) // atomic on the same filesystem
}

// tierOf(version) -> number. Higher = better quality. Used by the promotion gate.
// Default: rank by provider precedence, unknown providers lowest.
const DEFAULT_TIERS = { 'elevenlabs-scribe': 3, 'whisper-large-v3': 2, 'whisper-local': 1 }
const defaultTierOf = (v) => (v && DEFAULT_TIERS[v.provider]) ?? 0

export function createArtifactStore({ root, tierOf = defaultTierOf } = {}) {
  if (!root) throw new Error('createArtifactStore: root is required')
  const clipDir = (clipKey) => path.join(root, clipKey)
  const versionDir = (clipKey, hash) => path.join(clipDir(clipKey), hash)
  const manifestPath = (clipKey) => path.join(clipDir(clipKey), MANIFEST)

  async function readManifest(clipKey) {
    try { return JSON.parse(await readFile(manifestPath(clipKey), 'utf8')) }
    catch { return { clipKey, versions: [], current: null } }
  }

  async function has(clipKey, hash) {
    const m = await readManifest(clipKey)
    return m.versions.some((v) => v.artifactHash === hash) && exists(versionDir(clipKey, hash))
  }

  // Add a version. Files: { '<name>': Buffer|string, ... } — the mp3, the
  // .words.json sidecar, etc. `provenance` (provider/model/voice/settings/cost/
  // requestId/sourceSha) is REQUIRED and written as gen.json in the SAME atomic
  // publish, so an artifact can never exist without the metadata to reprocess it.
  // Idempotent: if the hash already exists, returns the existing version.
  async function put(clipKey, hash, { files = {}, provenance }) {
    if (!provenance || !provenance.provider) {
      throw new Error('put: provenance.provider is required (no un-reprocessable artifacts)')
    }
    if (await has(clipKey, hash)) return (await readManifest(clipKey)).versions.find((v) => v.artifactHash === hash)

    // Stage the whole version in a tmp dir, then publish with one rename.
    const dir = versionDir(clipKey, hash)
    const stage = `${dir}.staging-${randomBytes(6).toString('hex')}`
    await mkdir(stage, { recursive: true })
    try {
      const written = []
      for (const [name, data] of Object.entries(files)) {
        await writeFile(path.join(stage, name), data)
        written.push(name)
      }
      await writeFile(path.join(stage, 'gen.json'), JSON.stringify(provenance, null, 1))
      await rm(dir, { recursive: true, force: true }) // clear any prior partial
      await rename(stage, dir) // atomic publish — files + provenance land together
      const version = {
        artifactHash: hash,
        provider: provenance.provider,
        model: provenance.model ?? null,
        voice: provenance.voice ?? null,
        settings: provenance.settings ?? null,
        sourceSha: provenance.sourceSha ?? null,
        tier: null, // filled below via tierOf
        files: [...written, 'gen.json'],
        createdAt: provenance.createdAt ?? null,
      }
      version.tier = tierOf(version)
      const m = await readManifest(clipKey)
      if (!m.versions.some((v) => v.artifactHash === hash)) m.versions.push(version)
      await writeAtomic(manifestPath(clipKey), JSON.stringify(m, null, 1))
      return version
    } catch (e) {
      await rm(stage, { recursive: true, force: true }).catch(() => {})
      throw e
    }
  }

  async function listVersions(clipKey) {
    return (await readManifest(clipKey)).versions
  }

  function ref(clipKey, hash) {
    return { clipKey, artifactHash: hash, dir: versionDir(clipKey, hash) }
  }

  async function resolveCurrent(clipKey) {
    const m = await readManifest(clipKey)
    if (!m.current) return null
    const v = m.versions.find((x) => x.artifactHash === m.current)
    return v ? { ...ref(clipKey, m.current), version: v } : null
  }

  // Unconditional pointer flip (used with force, or when there is no current).
  async function setCurrent(clipKey, hash) {
    const m = await readManifest(clipKey)
    if (!m.versions.some((v) => v.artifactHash === hash)) {
      throw new Error(`setCurrent: version ${hash} not found for ${clipKey}`)
    }
    m.current = hash
    await writeAtomic(manifestPath(clipKey), JSON.stringify(m, null, 1))
    return hash
  }

  // THE QUALITY GATE. Promote `hash` to current ONLY IF it is at least as good
  // as the existing current (by tier), unless `force`. This is what stops a
  // transient fallback to a weaker provider — or a bulk cheap-provider backfill —
  // from silently downgrading a clip that already had a better version.
  async function promote(clipKey, hash, { force = false } = {}) {
    const m = await readManifest(clipKey)
    const next = m.versions.find((v) => v.artifactHash === hash)
    if (!next) throw new Error(`promote: version ${hash} not found for ${clipKey}`)
    const cur = m.current ? m.versions.find((v) => v.artifactHash === m.current) : null
    if (!force && cur && (next.tier ?? 0) < (cur.tier ?? 0)) {
      return { promoted: false, reason: `kept higher-tier current (${cur.provider} t${cur.tier} ≥ ${next.provider} t${next.tier})` }
    }
    await setCurrent(clipKey, hash)
    return { promoted: true, reason: cur ? `promoted over ${cur.provider} t${cur.tier}` : 'first version' }
  }

  return { has, put, listVersions, resolveCurrent, setCurrent, promote, ref, tierOf }
}
