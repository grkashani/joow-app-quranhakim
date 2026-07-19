# Quran Hakim — handoff pointer

**Canonical project + handoff docs are in the yQuran repo:**
`/Users/grkashani/projects/yquran/docs/` → `PROJECT.md` and `HANDOFF.md`
(GitHub: `github.com/grkashani/yquran`, `docs/`). Read those first — they cover both
products (yQuran platform + this Quran Hakim reader), the shared server, auth, and deploy.

See also the sibling docs here: [`README.md`](./README.md) (project + data provenance) and
[`ios-notes.md`](./ios-notes.md).

## This app in one screen
- Quran reader dedicated to the Bazargan tafsir. Live at https://quranner.com (+ raw IP) and
  embedded in yQuran's **Apps** tab.
- `web/` = React 18 + Vite SPA (plain JS). Backend = `backend/server.mjs`
  (raw `node:http`, on the box as `joowquran-api` → `127.0.0.1:8787`).
- **Deploy:** `cd web && npx vite build --base=/ && rsync -az --no-perms --omit-dir-times dist/ root@91.107.131.70:/var/www/quranner/`
  (the `--base=/` is required — the default base breaks the root deploy). iOS:
  `npx vite build --mode capacitor && npx cap sync ios`.

## Main remaining work — reader audio/version model (`web/src/pages/Reader.jsx`)
Full design in the canonical `yquran/docs/HANDOFF.md` §3. Summary:
1. **Top-of-screen version chooser** {short · long · meaning}; remove per-ayah selectors; the
   chosen version's transcript is always shown while playing.
2. **4-voice citation chooser** {Quran recitation · AI meaning (multi-lang) · short tafsir ·
   long tafsir}.
3. **Two Farsi tafsir audios** (short + long): the current single `/srv/tafsir/ssn/…` audio
   is the **short**; the **long** (full lecture) is on `quranhakimapp.com/ssn/` /
   `divaryab.com/pym/ssn/` (the original Adobe AIR app,
   `air.org.ePayam.QuranKarimAuidoTranslation`). Exact per-session URLs need a **network
   capture** from the running old app (see this folder's `README.md` → "Not yet ported").
   Download → `/srv/tafsir/long/…`, then transcribe.
4. **AI "meaning" audio** (ElevenLabs, multi-language) for the "meaning" version — generate
   **Fatiha only** (that's what has ElevenLabs credit); get-or-create + cache + share.

**Already shipped this session:** app icon/manifest (install shows the Quran Hakim mushaf
icon) and the read-along highlight (current word solid + next word lighter + persists through
silence).

## Don't-break
- Build with `--base=/` for quranner.com.
- ElevenLabs stays server-side, get-or-create + cached + shared, Fatiha-only; respect the
  `409` full-clip cost guard.
- Service worker `web/public/sw.js`: audio = cache-first, transcripts/data = network-first;
  bump the cache name (`jq-audio-v1`) if you change it.
