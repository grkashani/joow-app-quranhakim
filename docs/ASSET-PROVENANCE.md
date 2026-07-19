# Asset provenance, provider taxonomy & retention

Everything we hold is categorized by **provider**, and nothing generated is ever
deleted. Two reasons: (1) so we can reconstruct Bazargan's voice later in any
language with any engine, and (2) so paid output (STT, TTS credits) is never
re-bought. Catalog: `/srv/manifest.json` (rebuild with `build-manifest.mjs`).

## Providers

| Provider | What | Where |
|----------|------|-------|
| **original** | Human recordings — the source of truth. Bazargan's tafsir (long + short) and the everyayah reciters. **Never delete; irreplaceable.** | `/srv/tafsir/ssn`, `/srv/tafsir-short`, `/srv/recitation` |
| **elevenlabs** | AI TTS (tafsir + meaning, per language) and Scribe STT transcripts | `/srv/tafsir-tts`, `/srv/meaning-tts`, `/srv/transcripts` |
| **openai** | *Prepared, not yet used.* TTS via `openai-tts.mjs` → provider-keyed path | `/srv/assets/openai/<kind>/<lang>/…` |
| **derived** | Computed for free from the above; regenerable but kept: performance transcripts, voice profiles/fingerprint | `*.perf.json`, `/srv/voice-profiles` |

Going forward, **new providers write under `/srv/assets/<provider>/<kind>/<lang>/<c3>/<c3>_<v3>.mp3`** (+ `.words.json` + `.gen.json`). The legacy ElevenLabs/original paths stay where the reader already reads them; the manifest maps both.

## Voice-preservation set (to reconstruct his voice)

Cloning a voice needs clean reference audio + a characterization. We keep both:

- **Raw audio** — `/srv/tafsir/ssn` + `/srv/tafsir-short` (6 GB, all 12,472 ayahs). The ultimate source. Preserve off-site.
- **Per-ayah voice profile** — `voice-profile.py` → `/srv/voice-profiles/<kind>/<c3>/<c3>_<v3>.voice.json`: F0 stats, **formants F1–F4** (vocal-tract timbre), **HNR / jitter / shimmer** (voice quality), intensity, and a `cloneScore`.
- **Speaker fingerprint** — `voice-aggregate.mjs` → `/srv/voice-profiles/bazargan.fingerprint.json`: his aggregate signature (pitch identity, formants, voice quality).
- **Reference set** — `/srv/voice-profiles/reference-set.json`: the cleanest ~30 min of clips, spread across surahs, ready to hand a cloning engine.
- **Performance transcripts** — `*.perf.json` (see PERFORMANCE-TRANSCRIPT.md): how he delivers each ayah (pauses, emphasis, pitch, loudness).
- **Per-clip provenance** — every synthetic clip has a `.gen.json` (engine, voice, model, request-id, character cost). Never strip these.

**Cloning his voice requires his consent / rights.** These artifacts make it *possible*; permission makes it *allowed*.

## Retention

- **Never delete** `original` audio or any `.gen.json` provenance or any paid transcript.
- Backups: `/srv/backups/derived-text-<date>.tar.gz` (transcripts, perf, voice profiles, manifest) + `ai-audio-<date>.tar` (paid TTS). Re-run after big generation batches.
- **Off-site is still needed** for disk-failure safety (same-disk backup only guards against accidental deletion). Set up `rclone` to cloud when a bucket is available; include `/srv/tafsir`, `/srv/tafsir-short`, `/srv/transcripts`, `/srv/voice-profiles`, `/srv/tafsir-tts`, `/srv/meaning-tts`.

## Translation (multi-language, provider-agnostic)

`translate-tafsir.mjs` translates every Persian transcript into the 13 target
languages **segment by segment**, so each translation keeps his sentence
boundaries + timings (stays synced to his voice), and contributes it back via
`/api/transcript` (source `claude-translation`). The LLM backend is your choice —
**Anthropic**, or any **OpenAI-compatible endpoint incl. a free local model on a
Mac** (Ollama / LM Studio via `OPENAI_BASE_URL`). Ready now; needs a key/endpoint.
Scope waiting: ~14,573 short jobs + the long lectures. Runs only over what's
transcribed (transcription itself is paused — ElevenLabs Pro quota 610k exhausted).

## Voice-capture completeness — roadmap (from review, to maximize reconstruction)

Ranked; all free unless noted. Make the stored voice data usable by ANY TTS/clone:
- **P0 speaker embedding** — cloners ingest a neural speaker vector, not Praat
  numbers. Add ECAPA-TDNN (SpeechBrain) / WavLM-SV / Resemblyzer per reference
  clip + a corpus centroid; version by model id. (Compute on the reference set,
  not all 12k — RAM-friendly.)
- **P0 reference-clip segmentation + quality gate** — cut clean 5-30s clips from
  the long lectures (Silero/webrtc VAD + `librosa.trim`), and gate on true SNR,
  clipping/true-peak, and bandwidth (not just HNR/jitter). Produce a normalized
  (LUFS, fixed-SR) WAV bundle.
- **P0 integrity** — `sha256`/`b3sum` checksum manifest over the originals; wire
  `rclone --checksum` off-site; capture a signed consent/rights artifact.
- **P1** — phonetic-coverage-aware reference selection (align phones, fill gaps);
  vowel-conditioned formants; emotion/prosody diversity + SER labels; intonation-
  contour templates per sentence-type so prosody survives translation; spectral
  tilt + CPPS + articulation rate; embedding-based clone-similarity eval loop.
- Stamp every derived artifact with schema + tool version + params.

## Pipelines (all idempotent/resumable)

```
stt-bazargan-fa.mjs   original audio -> transcript + karaoke sidecar   (ElevenLabs Scribe)
tts-meaning.mjs       meaning text   -> meaning audio + sidecar         (ElevenLabs)
openai-tts.mjs        text           -> audio (provider-keyed)          (OpenAI, prepared)
perf-build.mjs all    transcript     -> performance transcript          (free)
pitch-driver.mjs      audio + perf   -> pitch/loudness merged           (free, Praat)
voice-driver.mjs      audio          -> voice profile                   (free, Praat)
voice-aggregate.mjs   profiles       -> fingerprint + reference set      (free)
build-manifest.mjs                   -> /srv/manifest.json               (free)
```
