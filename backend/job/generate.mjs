// The generation Job — ties registry + adapters + store into one idempotent,
// re-runnable, lossless flow. This is what a wired-up server.mjs get-or-create
// becomes. Capability-generic: STT / TTS / translate all follow the same path.
//
//   resolve provider chain (registry)
//     → for each provider: content-hash the request
//       → store HIT? promote (quality-gated) + return cached
//       → else: assert budget, call provider (caller wraps withTimeout),
//               put() a NEW version (never overwrite, provenance atomic),
//               promote() through the quality gate, return
//       → retryable failure? fall to the next provider; non-retryable? throw
//
// clipKey-level in-flight DEDUP (the pre-mortem's fix): two concurrent misses on
// the same clip share ONE generation, so fallback can't double-generate /
// double-charge. Dedup is on the clipKey, but each attempt stores under its own
// content hash — so a re-run with a better provider still adds a new version.
import { artifactHash } from '../store/hash.mjs'
import { isRetryable } from '../providers/registry.mjs'

export function createGenerator({ registry, store, budget = null } = {}) {
  if (!registry || !store) throw new Error('createGenerator: registry + store required')
  const inflight = new Map() // clipKey -> Promise

  function dedup(clipKey, fn) {
    if (inflight.has(clipKey)) return inflight.get(clipKey)
    const p = Promise.resolve().then(fn).finally(() => inflight.delete(clipKey))
    inflight.set(clipKey, p)
    return p
  }

  // capability: 'stt' | 'tts' | 'translate'
  // scope:      { lang?, tafsir?, override? } — how the registry picks providers
  // sourceSha:  hash of the source (audio for stt, text for tts/translate)
  // call(provider) -> Promise<result>   (caller decides args + withTimeout)
  // toArtifact(result, provider) -> { files:{name:data}, provenance:{...extra} }
  async function generate({ capability, clipKey, scope = {}, sourceSha, call, toArtifact, force = false }) {
    return dedup(clipKey, async () => {
      // GET: unless this is an explicit override / quality pass (force), return the
      // current best artifact if one already exists. With the legacy bridge this
      // includes the existing flat /srv file — the "keep" policy's $0 path: a page
      // load never re-derives a clip we already have. An override sets forced=true
      // to bypass this gate and regenerate, letting the quality gate judge the result.
      const forced = force || !!scope.override
      if (!forced && typeof store.resolveAcceptable === 'function') {
        const existing = await store.resolveAcceptable(clipKey)
        if (existing) return { ...existing, cached: true, promoted: false }
      }

      const chain = registry.resolve(capability, scope)
      if (!chain.length) throw new Error(`no ${capability} provider resolved for ${JSON.stringify(scope)}`)
      let lastErr = null
      for (const provider of chain) {
        const hash = artifactHash({ kind: capability, provider: provider.id(), model: provider.model || '', sourceSha })
        if (await store.has(clipKey, hash)) {
          const promo = await store.promote(clipKey, hash).catch(() => ({ promoted: false }))
          return { ...store.ref(clipKey, hash), cached: true, provider: provider.id(), promoted: promo.promoted }
        }
        try {
          if (budget) await budget.assert(provider.id())
          const result = await call(provider)
          const { files, provenance } = toArtifact(result, provider)
          const version = await store.put(clipKey, hash, {
            files,
            provenance: {
              provider: provider.id(),
              model: provider.model || null,
              sourceSha,
              createdAt: (provenance && provenance.createdAt) || null,
              ...provenance,
            },
          })
          const promo = await store.promote(clipKey, hash)
          return { ...store.ref(clipKey, hash), cached: false, version, provider: provider.id(), promoted: promo.promoted }
        } catch (e) {
          lastErr = e
          if (!isRetryable(e)) throw e // a real request bug — don't paper over it with a fallback
          // else: transient/availability — fall through to the next provider
        }
      }
      throw lastErr || new Error(`all ${capability} providers exhausted for ${clipKey}`)
    })
  }

  return { generate, _inflight: inflight }
}
