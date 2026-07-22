// Provider contracts (plain JS + JSDoc). An adapter is a plain object created by
// a `create<Vendor><Cap>Adapter({ ...injected deps })` factory — deps are
// injected (fetch, readFile, spawn, apiKey…) so every adapter is unit-testable
// without touching a real vendor. The registry + Job rely only on these shapes.
//
// @typedef {Object} ProviderMeta
//   @property {string} provider   — stable id, e.g. 'elevenlabs-scribe'
//   @property {string} [model]
//   @property {string} [requestId]
//   @property {number} [cost]     — character/second cost if the vendor returns it
//
// TranscriptionProvider: { id(): string, transcribe(audioPath, {lang?}) =>
//   Promise<{ text:string, words?:{t:string,s:number,e:number}[], providerMeta:ProviderMeta }> }
//
// TtsProvider: { id(): string, supportsTimestamps(): boolean,
//   synthesize(text, {voice?,lang?,settings?}) =>
//   Promise<{ audio:Buffer, alignment?:{raw,normalized}, words?:{t,s,e}[], providerMeta:ProviderMeta }> }
//
// TranslationProvider: { id(): string, translate(text, {src,dst}) =>
//   Promise<{ text:string, providerMeta:ProviderMeta }|null> }

// A provider error carrying a status so isRetryable() can classify it for fallback.
export function providerError(message, status) {
  const e = new Error(message)
  if (status != null) e.status = status
  return e
}

// Length-aware timeout: caps a provider call but scales the ceiling with the
// input, so a legitimately long ayah doesn't start failing a clip that succeeds
// today (the pre-mortem's "flat 60s would fail long clips" note). Rejects with an
// ETIMEDOUT-coded error so isRetryable() triggers fallback.
export function timeoutFor(baseMs, sizeHint = 0, perUnitMs = 0) {
  return Math.round(baseMs + Math.max(0, sizeHint) * perUnitMs)
}

export function withTimeout(promise, ms, label = 'provider') {
  let t
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      const e = new Error(`${label} timeout after ${ms}ms`)
      e.code = 'ETIMEDOUT'
      reject(e)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}
