// recordGeneratedClip — the SAFE first activation of the versioned store in the
// live backend. It records an already-generated, already-served clip into the
// content-addressed store as a lossless version, WITHOUT changing anything that
// is served: the canonical mp3 stays on its flat /srv path (served by nginx); the
// version here holds the small sidecars (word timings + provenance) + a pointer
// to the served URL. So the "never lose / always improve" history starts accruing
// the moment a clip is made, at ~no extra storage and zero serving risk.
//
// Contract: BEST-EFFORT. Every caller wraps this in try/catch and ignores errors
// — a store hiccup must never break audio generation. Idempotent: re-recording an
// identical (provider, model, source) clip is a no-op.
import { artifactHash, sha256 } from './hash.mjs'

export async function recordGeneratedClip(store, layout, {
  kind,             // 'stt' | 'tafsir' | 'tafsir-seg' | 'meaning'
  id, lang, s, a, seg, ann,   // clip coordinates (id absent for meaning)
  provider,         // e.g. 'elevenlabs-tts' | 'elevenlabs-scribe'
  model = '',
  sourceText = '',  // the exact text that was synthesized/transcribed (for the hash + provenance)
  sidecars = {},    // { 'words.json': string, 'gen.json': string, ... } — small; NOT the mp3
  extra = {},       // any extra provenance fields
} = {}) {
  if (!provider) throw new Error('recordGeneratedClip: provider is required')
  const desc = layout.describe({ kind, id, lang, s, a, seg, ann })
  const sourceSha = sourceText ? sha256(sourceText) : ''
  const hash = artifactHash({ kind, provider, model, sourceSha })

  if (await store.has(desc.clipKey, hash)) {
    return { recorded: false, reason: 'exists', clipKey: desc.clipKey, hash }
  }
  // 'gen.json' is reserved by the store for its OWN provenance. The live backend's
  // rich provenance sidecar is also called .gen.json — rename it so both survive.
  const files = {}
  for (const [name, data] of Object.entries(sidecars)) {
    files[name === 'gen.json' ? 'source-gen.json' : name] = data
  }
  await store.put(desc.clipKey, hash, {
    files,
    provenance: {
      provider, model: model || null, sourceSha,
      servedUrl: desc.url,          // the flat path nginx serves (the mp3 lives here, not duplicated)
      servedPath: desc.legacyPath,
      ...extra,
    },
  })
  const promo = await store.promote(desc.clipKey, hash)
  return { recorded: true, clipKey: desc.clipKey, hash, promoted: promo.promoted }
}
