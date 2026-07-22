// Legacy bridge — lets the versioned ArtifactStore sit over the EXISTING flat
// /srv tree without mass-regenerating the ~20k paid clips already on disk.
//
// It is a drop-in store (same interface the generator uses) that DELEGATES every
// method to the versioned store, and adds ONE piece of intelligence:
// `resolveAcceptable(clipKey)` — "is there already something good enough to serve?"
//
//   1. a promoted VERSIONED current  -> use it (source:'versioned')
//   2. else, under legacyAcceptance:'keep', the LEGACY flat file if it exists on
//      disk -> keep serving it, DON'T regenerate (source:'legacy')  [the $0 default]
//   3. else -> null (nothing yet; the generator will create it)
//
// This is the policy the owner chose (WIRING-DECISION.md: "keep"): legacy clips
// are never re-derived by a page load; quality only improves on an EXPLICIT
// re-run (an override/quality pass sets force), which writes a NEW version and
// the quality gate decides whether it becomes current — legacy is superseded but
// its file stays on disk. legacyAcceptance:'rederive' turns the legacy overlay
// off (treat legacy as absent), for a deliberate bulk upgrade lane.
//
// has()/promote()/put() stay EXACT (versioned-only), so per-provider dedup and
// the quality gate are unchanged. Only the get-or-create "do we already have
// this?" decision is legacy-aware — which is exactly where the money is.
import { access } from 'node:fs/promises'

const fsExists = (p) => access(p).then(() => true, () => false)

export function createLegacyBridge({
  store,
  layout,
  fileExists = fsExists,   // injectable for tests
  legacyAcceptance = 'keep',
  legacyTier = 0,
} = {}) {
  if (!store || !layout) throw new Error('createLegacyBridge: store + layout required')
  if (legacyAcceptance !== 'keep' && legacyAcceptance !== 'rederive') {
    throw new Error(`createLegacyBridge: legacyAcceptance must be 'keep' or 'rederive'`)
  }

  const describeFor = (clipKey) => layout.describe(layout.parseClipKey(clipKey))

  async function legacyExists(clipKey) {
    return fileExists(describeFor(clipKey).legacyPath)
  }

  // The get-or-create gate: the current best artifact for this clip, or null.
  async function resolveAcceptable(clipKey) {
    const desc = describeFor(clipKey)
    const cur = await store.resolveCurrent(clipKey)
    if (cur) return { source: 'versioned', url: desc.url, ...cur }
    if (legacyAcceptance === 'keep' && (await legacyExists(clipKey))) {
      return {
        source: 'legacy',
        clipKey,
        url: desc.url,
        legacyPath: desc.legacyPath,
        version: { provider: 'legacy', tier: legacyTier },
      }
    }
    return null
  }

  return {
    // legacy-aware additions
    resolveAcceptable,
    legacyExists,
    describeFor,
    legacyAcceptance,
    // straight delegation — versioned semantics unchanged
    has: (...a) => store.has(...a),
    put: (...a) => store.put(...a),
    promote: (...a) => store.promote(...a),
    listVersions: (...a) => store.listVersions(...a),
    resolveCurrent: (...a) => store.resolveCurrent(...a),
    setCurrent: (...a) => store.setCurrent(...a),
    ref: (...a) => store.ref(...a),
    tierOf: store.tierOf,
  }
}
