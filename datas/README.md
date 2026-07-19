# JoowQuran canonical data

> **Dedicated app.** This app is dedicated to the **bazargan** tafsir ("Quran Hakim"). Additional tafsirs ship as separate mini-apps on the platform, all sharing this exact storage layout.

One structure, three locations — **repo (source of truth) → server (`/srv`, served by nginx) → device (downloaded for offline)**. The paths are identical everywhere, so sync is a path copy and the app reads **local-first, then server**.

## Asset key

Every transcript and every audio clip is addressed by:

```
tafsirs/<tafsir>/<kind>/<engine>/<lang>/<sss>/<sss>_<aaa>.<ext>
         │        │       │        │      │     └ ayah (3-digit)
         │        │       │        │      └ surah (001–114)
         │        │       │        └ language: fa · en · ar · ur …
         │        │       └ engine: who produced it (see providers.json)
         │        └ kind: audio (.mp3) | transcripts (.json)
         └ tafsir id (slug, e.g. "bazargan"; numeric alias "tafsir-001")
```

Examples (engine = a provider id from `providers.json`):
- `tafsirs/bazargan/audio/original/fa/002/002_001.mp3` — the human tafsir recording.
- `tafsirs/bazargan/audio/elevenlabs/en/002/002_001.mp3` — ElevenLabs TTS English narration.
- `tafsirs/bazargan/transcripts/elevenlabs/fa/002/002_001.json` — ElevenLabs Scribe (STT) Persian transcript.
- `tafsirs/bazargan/transcripts/claude/en/002/002_001.json` — Claude translation, English.
- `tafsirs/bazargan/transcripts/device/fa/002/002_001.json` — on-device STT (iOS), where supported.

> On the **server**, v2 paths carry an `@` before the provider (`…/@elevenlabs/fa/…`) so they coexist with the legacy `…/<lang>/…` files during migration. The canonical repo/device tree uses the plain provider id; the download/sync layer maps between them.

## The matrix

Each ayah can hold **many** transcripts and **many** audios, one per `(kind, engine, language)` cell:

| kind | engine (examples) | operation | languages |
|------|-------------------|-----------|-----------|
| audio | `original` | human recording | source (fa) |
| audio | `elevenlabs`, `openai`, `piper` | TTS (text→speech) | any |
| transcript | `scribe`, `whisper`, `google` | STT (speech→text) | source |
| transcript | `claude`, `deepl`, `human` | translation (text→text) | any |

**Invariant:** `claude` fills transcript cells only — it has no audio (no STT, no TTS).

The user picks a transcript source and, independently, an audio source, per ayah — mix and match.

## Files

- `providers.json` — the engine registry (ids, capabilities, models, cost, languages). Adding a provider = a registry entry, not a code change.
- `manifest.json` — generated index of what exists (per tafsir → kind → engine → lang → surahs). The app reads it to build the source pickers, offer downloads, and know what's already local. Regenerate from the server after any generation run.
- `tafsirs/<id>/tafsir.json` — tafsir metadata.

## Local-first storage (per platform)

Audio is too large for the browser `localStorage` API. On-device data uses:
- **Native (iOS/Android, Capacitor Filesystem):** real files under `Documents/datas/…` — this exact tree.
- **Web (browser):** the same paths as keys in the **Cache Storage API** (today) / OPFS; a service worker serves them offline.
- **`localStorage`:** small state only (prefs, last-read, chosen sources) — never audio.

Read order at runtime: **device cache → server** (`https://quranner.com/<path>`), generating on a cache miss via the API and persisting so it's cached once for everyone.

> The actual audio (multi-GB) lives on the server + gets downloaded to devices — it is **not** committed to the repo. The repo holds this structure, the registry, manifests, and (optionally) the small transcript JSONs.
