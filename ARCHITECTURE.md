# JoowQuran — Architecture

A multi-tafsir Quran listening app: original-language tafsir audio, on-demand transcription, and AI translation into other languages, delivered as a web SPA and native Android/iOS builds.

## System overview

```
Client (React SPA / Capacitor app)
        │  audio streamed from https://quranner.com
        │  transcripts fetched via /api/transcript
        ▼
nginx  ──►  static: /tafsir/  /recitation/  /transcripts/
       └──►  proxy:  /api/*  →  joowquran-api (Node, systemd)
                                     │
                        ElevenLabs Scribe STT (transcribe)
                        ElevenLabs TTS v3      (translated audio)
                        Anthropic API          (translate text)
```

## Frontend

- **Stack:** Vite + React SPA under `apps/joowquran/web`.
- **Tabs / navigation:** surah/ayah browsing plus per-ayah tafsir listening; playback streams audio directly from `https://quranner.com`.
- **i18n:** UI is localized; users can request tafsir transcripts/translations in a chosen `lang`.
- **Multi-tafsir registry:** `data/tafsirs.json` lists each tafsir with `id`, `language`, `audio.pattern` (e.g. `/tafsir/ssn/{c3}/{c3}_{v3}.mp3`), and `transcript.lang`. `{c3}`/`{v3}` are zero-padded 3-digit chapter/verse numbers.
- **Surah metadata:** `data/surahs.json` provides ayah counts and a per-surah `ttlVer`; counts sum to 6236 ayat.
- **Transcripts:** for the current tafsir/surah/ayah/lang the client calls `GET /api/transcript`; results are cached server-side and shared across all users.

## Backend

Node service `server.mjs` at `/srv/joowquran-api/`, run as systemd unit `joowquran-api`, fronted by nginx.

**Endpoints**

- `GET /api/transcript?tafsir=&surah=&ayah=&lang=` — get-or-create a transcript.
  1. Transcribes the **local** tafsir audio clip in its original language via ElevenLabs Scribe STT (`ELEVENLABS_API_KEY`, model `scribe_v2`).
  2. If `lang` differs from the tafsir's native language, translates the text via the Anthropic API (`ANTHROPIC_API_KEY`, optional).
  3. Persists JSON to the shared cache and returns it.
  4. **In-flight de-duplication:** concurrent requests for the same key await a single generation instead of triggering duplicate STT/translation calls.
- `GET /api/health` — returns `{ok, stt, translator, model}` reflecting configured keys and STT model.

**TTS (translated audio):** ElevenLabs TTS v3 generates spoken audio from translated transcript text, so a tafsir originally recorded in one language can be heard in another.

## Data layout on the server

- Tafsir audio corpus: `/srv/tafsir/ssn/<c3>/<c3>_<v3>.mp3` — 6236 Bazargan clips.
- Recitation audio: `/srv/recitation/`.
- Transcript cache: `/srv/transcripts/<tafsir>/<lang>/<c3>/<c3>_<v3>.json`.
- nginx serves `/tafsir/`, `/recitation/`, and `/transcripts/` as static files and proxies `/api/*` to the Node service.

## Lazy generation, caching, and sharing

Transcripts and translations are **never precomputed**. On first request for a given `tafsir/lang/surah/ayah`, the API transcribes (and translates if needed), writes the JSON to `/srv/transcripts/...`, and returns it. Because the cache lives on disk and is served statically by nginx, every subsequent user — regardless of device — gets the same file instantly. In-flight de-dup ensures a burst of first-time requests still produces exactly one generation.

## Native apps (Capacitor)

The same web build is packaged as **Capacitor Android and iOS** apps:
- Web assets are bundled into the app.
- Audio is streamed from `https://quranner.com` (not bundled).
- `iosScheme` and `androidScheme` are both `https`, keeping the embedded web context on an https origin for consistent networking and CORS behavior with the API and audio hosts.