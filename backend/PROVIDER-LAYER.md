# Provider layer + versioned artifact store (Phase 2/3 scaffolding)

**Status: NEW, TESTED, UNWIRED, UNDEPLOYED.** None of this is imported by
`server.mjs` yet; the live backend is unchanged. Built overnight 2026-07-21 as
the executable version of the architecture plan (pluggable providers + lossless,
versioned, always-upgradeable artifacts). `cd backend && npm run test` → 74 green.

## Module map

```
providers/
  types.mjs            contracts (JSDoc) + providerError() + withTimeout()/timeoutFor()  (length-aware)
  registry.mjs         createRegistry(): resolve(capability,scope) → ordered provider chain; isRetryable()
  elevenlabs-stt.mjs   TranscriptionProvider  (wraps server.mjs elevenLabsSTT — reference adapter)
  whisper-stt.mjs      TranscriptionProvider  (faster-whisper via injected run(); the free/fallback path)
  elevenlabs-tts.mjs   TtsProvider            (wraps ttsElevenLabsTimed, /with-timestamps)
  translate-anthropic  TranslationProvider    (wraps translate())
  translate-openai     TranslationProvider    (OpenAI-compatible; the free/local path)
store/
  hash.mjs             artifactHash({kind,provider,model,voice,settings,sourceSha}) incl. PIPELINE_VERSION
  artifact-store.mjs   content-addressed, never-overwrite, atomic publish, promote() quality gate
  layout.mjs           exact /srv path+URL+sidecar math (extracted from server.mjs) + describe()/parseClipKey()
  legacy-bridge.mjs    legacy-aware store overlay: resolveAcceptable() honours the "keep" policy (dual-read old→new)
job/
  generate.mjs         createGenerator(): the get-or-create flow tying it all together (clip-level keep gate + force)
```

## The flow (`job/generate.mjs`)

```
resolve provider chain (registry, by capability + scope: lang/tafsir/override)
  → for each provider, in order:
      hash = artifactHash(kind, provider, model, sourceSha, PIPELINE_VERSION)
      store HIT?  → promote (quality-gated) + return { cached:true }
      else:       assert budget → call provider (caller wraps withTimeout)
                  → store.put(clipKey, hash, {files, provenance})   // NEW version, atomic, never overwrite
                  → store.promote(clipKey, hash)                     // quality gate
                  → return { cached:false, version, promoted }
      retryable failure (402/429/5xx/timeout/past_due)? → next provider
      non-retryable (400/401)? → throw (a real request bug, not papered over)
  clipKey-level in-flight DEDUP → concurrent misses share one generation (no double-charge)
```

## The guarantees baked in (from the pre-mortem)

- **Never overwrite / lossless.** Every generation writes a NEW version under its
  content hash. A better provider or a `PIPELINE_VERSION` bump = a new coexisting
  version. `resolveCurrent` follows a `current` pointer; rollback = flip it back.
- **Atomic publish.** Files + `gen.json` provenance are staged in a tmp dir and
  published with ONE rename — no artifact is ever exposed without the metadata to
  re-process it.
- **Quality gate.** `promote()` refuses to replace a higher-tier `current` with a
  lower-tier version (a transient Scribe→Whisper fallback, or a bulk cheap backfill,
  can't silently downgrade a good clip). `force` + `setCurrent` allow explicit
  upgrade/rollback.
- **Pluggable + validated.** Swapping Whisper↔Scribe or adding OpenAI TTS is an
  adapter + a config line — never a call-site edit. (Mirrors the platform
  `joow-ai-gateway` shape; not coupled to it.)

## Wiring plan (Phase 2/3 — DO NOT do blind; review + verify first)

1. **Backend characterization first** (Phase 1b): pin `server.mjs`'s current
   `getOrCreate` / `getOrCreateTts` request→response so the swap is byte-identical.
   Needs `server.mjs` split into bootstrap vs. logic (a reviewed refactor).
2. ✅ **DONE (unwired):** the dual-read bridge is built — `layout.mjs` gives the exact
   legacy path/URL for any clipKey, and `legacy-bridge.mjs` (`legacyAcceptance:'keep'`)
   makes `resolveAcceptable()` treat an existing flat file as already-generated, so
   content-addressing never mass-regenerates. `rederive` is the opt-in bulk-upgrade lane.
3. Replace the inlined provider calls in `getOrCreate*` with `registry.resolve()` +
   `generate({store: bridge})`; register the adapters from env/`tafsirs.json engines{}`.
   On promote, publish the current version's files to the flat served path so nginx
   keeps serving the same URL (or add a resolver route).
4. Reader/yQuran deploy ordering for any URL change; separate batch-budget lane for
   bulk re-processing (`force`/`rederive`).

Everything above is additive and reversible. Nothing here ships until wired,
reviewed, and verified against the Phase-1b fixtures.
