# Performance transcript — preserving Bazargan's delivery for multilingual TTS

Goal: capture not just *what* Bazargan says but *how* he says it — his pauses,
stress, pace, and intonation — in a portable format, so a future AI can
re-perform it **in any language** and sound human, keeping the sense of his voice.

The artifact is `<transcript>.perf.json`, written next to each STT transcript
(`/srv/transcripts/bazargan[-short]/fa/<c3>/<c3>_<v3>.perf.json`). It is
**segment-anchored** (sentence-level), so a translated sentence inherits the same
delivery. It renders to **SSML** for any TTS engine.

## Three layers

| Layer | What it captures | Cost | Source |
|-------|------------------|------|--------|
| **1 — timing** | pauses (before/after), emphasis (hold + surrounding silence), pace per phrase, sentence segmentation | free | word timings already in the STT transcript |
| **2 — events** | breaths, sighs, non-speech texture | ElevenLabs credits | re-STT with `tag_audio_events=true` |
| **3 — acoustic** | **F0 pitch** (tone/intonation), **loudness** (stress) per word | free (CPU) | Praat analysis of the mp3 |

Layers 1 and 3 are built and merged. Layer 2 is captured on the next STT pass
(flip the flag in `stt-bazargan-fa.mjs`).

## Format (per word)

```json
{ "w": "الرحیم.", "s": 2.08, "e": 2.56, "dur": 0.48,
  "pauseBefore": 0.02, "pauseAfter": 2.2,     // seconds of silence around it
  "emphasis": 1.0,                            // 0..1, from hold + silence (Layer 1)
  "f0": 113.4, "f0st": 1.75,                  // pitch: Hz, and semitones vs clip median (Layer 3)
  "slope": 4.66,                              // pitch change across the word, semitones (+rising)
  "energy": 5.9 }                             // loudness vs clip median, dB (stress)
```

Segment: `{ id, text, start, end, pauseBefore, pauseAfter, pace, wordsPerSec, words[] }`.
Clip header: `speaker: { medWordDur, secPerChar, medF0, medDb, words }` — the
baselines everything is normalized against, so values are comparable across clips.

Example (Fatiha basmala): *الله* carries +8.7 dB (stressed by volume); *الرحیم*
rises +4.66 semitones and is held 0.48s then a 2.2s pause — his signature cadence.

## Pipeline

```
perf-build.mjs  <transcript.json | all>   # Layer 1 -> .perf.json  (+ --ssml to preview)
pitch-driver.mjs                          # Layer 3 -> merges f0/f0st/slope/energy per word
                                          #   (needs ffmpeg + /srv/prosody-venv: praat-parselmouth, numpy)
pitch-energy.py <audio.mp3> <perf.json>   #   single-file worker the driver spawns
```

Both are idempotent/resumable. When more surahs are transcribed (credits), re-run
`perf-build.mjs all` then `pitch-driver.mjs` to extend the performance layer.

## How another AI uses it

1. **Translate** each segment's text to the target language.
2. **Carry the delivery**: map the segment's pace + the emphasis/pitch/pause
   profile onto the translation (emphasis positions align to the stressed
   content words; segment pauses are preserved verbatim).
3. **Render**: emit SSML (`<break>` for pauses, `<emphasis>` for stress,
   `<prosody rate>` for pace; pitch/energy inform emphasis strength) — or feed a
   prosody-transfer TTS directly.
4. For the actual **timbre** of his voice, pair this script with a licensed
   voice clone (rights/consent required). The script is the engine-agnostic
   "director's notes"; the clone is the instrument.
