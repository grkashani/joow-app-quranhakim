// Provider registry — the single place that knows which provider to use.
//
// A Job never names a vendor. It calls registry.resolve(capability, scope) and
// gets back an ORDERED chain of providers to try (first = preferred, rest =
// fallback on retryable failure). The chain is built from config precedence:
//
//   scope.override  →  config.scopes["<capability>:<lang>" | "<capability>:<tafsir>"]
//                   →  config.defaults[capability]
//
// Selection is per-scope, so we can run local Whisper for bulk backfill on fa
// today and pin ElevenLabs Scribe for a final quality pass later — same corpus,
// both retained. Swapping a provider is a config line + an adapter, never a
// call-site edit. This mirrors the platform ai-gateway's shape (validated by it,
// not coupled to it — see the platform-alignment note).
//
// A capability adapter is any object with: id() → string, and the capability's
// verb (transcribe / synthesize / translate). See providers/types.mjs.

export function createRegistry({ config = {} } = {}) {
  // capability -> Map<id, provider>
  const reg = new Map()

  function register(capability, provider) {
    if (!provider || typeof provider.id !== 'function') throw new Error('register: provider needs id()')
    if (!reg.has(capability)) reg.set(capability, new Map())
    reg.get(capability).set(provider.id(), provider)
    return provider
  }

  function get(capability, id) {
    return reg.get(capability)?.get(id) ?? null
  }

  // Returns the ordered list of ids for (capability, scope) from config, before
  // resolving to instances. Exposed for testing the precedence logic directly.
  function chainIds(capability, scope = {}) {
    if (scope.override) return [scope.override]
    const scopes = config.scopes || {}
    const byLang = scope.lang && scopes[`${capability}:${scope.lang}`]
    const byTafsir = scope.tafsir && scopes[`${capability}:${scope.tafsir}`]
    const chosen = byLang || byTafsir || (config.defaults || {})[capability] || []
    return Array.isArray(chosen) ? chosen : [chosen]
  }

  // Resolve to the actual provider instances, skipping any id that isn't
  // registered (so a config referencing an unavailable provider degrades to the
  // next in the chain instead of throwing).
  function resolve(capability, scope = {}) {
    return chainIds(capability, scope)
      .map((id) => get(capability, id))
      .filter(Boolean)
  }

  return { register, get, resolve, chainIds }
}

// Whether an error should trigger fallback to the next provider in the chain
// (transient/availability failures) vs. bubble up (a real bug in our request).
export function isRetryable(err) {
  if (!err) return false
  const s = err.status ?? err.statusCode
  if (s === 402 || s === 408 || s === 429 || (s >= 500 && s < 600)) return true
  const code = String(err.code || err.name || err.message || '').toLowerCase()
  // `timed?out` matches both "timeout" and Node's ETIMEDOUT (with the 'd').
  return /timed?out|abort|econnreset|enotfound|eai_again|socket hang up|past_due|payment/.test(code)
}
