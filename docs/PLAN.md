# Quran Hakim — Production-Readiness Plan

*Synthesized from five area audits (reader-ux, backend-api, offline-pwa, content-data, ios-deploy). 2026-07-18.*

---

## 1. Where the app stands

Quran Hakim is a real, working product with an unusually careful core: the Fatiha experience (recitation, tafsir, karaoke, 14-language study view) is coherent end-to-end, the auth and cost-guard code is genuinely well-engineered, and the deliberate Fatiha-only content scope was a sound call. What is not ready is everything at the edges of that scope: surahs 2–114 leak raw provider errors to readers, the 6GB offline download cannot actually be used offline, the iOS app cannot be submitted or even sign in, and — most urgently — the entire source tree is untracked in git while the server has two unauthenticated file-write holes running as root. The gap to production is not a rewrite; it is a prioritized cleanup of edge states plus a handful of owner-provided inputs.

**Already working well:**

- **Player architecture** — one shared `<audio>` element drives all five play kinds; basmala logic is correct (shared 1:1 recording, skipped for surahs 1 and 9, flows into continuous play); pause/resume, speed persistence, seek rail with ARIA semantics, loading states at every level.
- **Karaoke word sync** — binary search over word timestamps, click-to-seek, highlight-through-silence; the unified `{n,i,lang}` active-sentence value drives study view and player bar consistently.
- **Listen (added languages)** — correctly bifurcated fa-vs-TTS paths; the playlist path fails friendly and stops cleanly; clip URLs memoized; the idx-vs-seg server pitfall handled and documented.
- **Study view bidi handling** — RTL source + LTR/RTL added languages mix safely (`dir="auto"`, `unicode-bidi: plaintext`).
- **Language settings** — single source of truth with legacy migration, cross-component sync, at-least-one invariant; Reader re-fetches exactly the missing languages on change.
- **Auth** — RS256 JWKS verification with alg pinning, nonce binding via `timingSafeEqual`, hardened HS256 sessions, Bearer-only (no cookies), transport gating, auth-budget burn on failures.
- **Comments API** — bounds-checked, control-char stripped, O_APPEND atomic NDJSON, rate-limited, token-authoritative attribution.
- **Cost guards** — full-ayah TTS off by default, in-flight dedup + disk cache means each clip is paid for exactly once, atomic tmp-then-rename writes.
- **Downloads machinery** — resumable, cancellable, 4-way parallel, survives route changes, auto-resumes, requests durable storage, never caches non-OK responses.
- **Content corpus** — all 114 surahs / 6,236 ayahs validated with ar+fa+en; full short-tafsir (ssn) audio coverage verified live; 14 reciters working; the Fatiha 14-language transcript grid is real and internally consistent (identical 67-sentence grids, 1,046 fa word timestamps).
- **iOS shell config** — Capacitor 8 SPM, correct ATS posture, custom Swift speech plugin properly registered, accurate battle-tested `ios-notes.md`.
- **Ops basics** — systemd Restart=always, `/api/health`, localhost-only bind behind nginx, env-var config, self-completing fatiha-backfill timer, sw.js/index.html served no-cache so deploys reach users.

---

## 2. The one external blocker

**The ElevenLabs invoice is unpaid**, and every language-audio feature waits on it: per-sentence TTS clips, added-language Listen, new STT transcripts, and the planned AI-meaning voice all currently die on a 401 `payment_issue`. The design here is good — the `fatiha-backfill` systemd timer self-completes once billing is restored, with no redeploy needed, and cached Fatiha content keeps serving throughout.

Two caveats so payment isn't mistaken for a full fix:

1. **Seg-TTS will not self-heal.** The UI plays only per-sentence `.seg` clips, and zero exist on the server. The backfill tooling only warms transcripts; the ~6,100 Fatiha sentence clips will otherwise trickle in one-per-user-click. A batch driver is needed (Workstream 5).
2. **Payment arms a cost bomb.** Today, opening the transcript panel on surahs 2–114 fires up to 14 doomed API calls; once billing resumes, those same calls trigger *paid* STT + translation with no client gate. Ship the client-side scope gate (Workstream 2) **before** paying the invoice.

---

## 3. Plan to ready

### WS1 — Commit the code and close the server holes — **Effort: S** — *Blocked on: nothing. Do first.*

**Why:** The entire app is untracked in git (a laptop failure loses the product), and the API has an unauthenticated arbitrary-file-write running as **root** — a full-host-compromise path reachable by any anonymous client. Everything else in this plan is moot if either bites.

**Steps:**
1. `git add` / commit / push `apps/joowquran` (`.gitignore` entries already exist for `dist/` and the iOS `public/` bundle).
2. Sanitize `lang` against an allowlist (the 14 known codes) or `/^[a-z]{2,8}(-[A-Za-z0-9]{2,8})?$/` before it reaches `path.join` in `cachePath`/`ttsSegPath`/`ttsPath` (reads *and* writes).
3. Bound `surah` 1–114 / `ayah` 0–300 on `POST /api/transcript` (mirror `/api/comments`).
4. Require a server-side shared secret (or authenticated privileged token) for `replace: true` uploads; rate-limit the contribute path.
5. Drop root: dedicated service user, chown `/srv` data dirs, add `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=`, `PrivateTmp` to the unit.

**Files:** `backend/server.mjs`, `backend/joowquran-api.service`, repo root.

---

### WS2 — Fix broken/confusing Reader states — **Effort: M** — *Blocked on: nothing.*

**Why:** These are the states real users hit today: raw `ElevenLabs STT 401: {payment_issue...}` JSON rendered to readers, silent no-op buttons, blank translation lines, and a dead-end error screen. This is also the prerequisite gate before paying the invoice (see §2).

**Steps:**
1. **Never show provider errors.** Server: log upstream bodies, return generic messages (`server.mjs:581, 594, 613`). Client: treat any `!r.ok` TTS failure as `ttsUnavailable` (not just 503 — billing failures return 502), and replace the transcript panel's verbatim error render with a friendly state. This makes the stated intent ("raw provider error is logged, never shown") true on all paths, not just the Listen playlist.
2. **Client-side scope gate.** For surahs without static transcripts, show a designed "study content is available for Al-Fatiha; more coming" state instead of firing up to 14 get-or-create calls. Prevents both the error leak and the paid fan-out post-payment.
3. **Listen button:** show `noTranscript`/`ttsUnavailable` when segments are missing instead of silently returning; add a busy indicator between tap and first audio (invite-to-double-tap today).
4. **Surah-load errors:** `setError(null)` in the surahNum effect; give the error screen a retry and back link.
5. **Translation lines:** either trim the 14-language picker to languages with data, or render a "not available for this surah" note where `a.t?.[l]` is absent (6 of 14 languages have no data anywhere — picking Urdu currently looks like a bug).
6. **localStorage safety:** wrap transcript-cache and `jq.speed` writes in try/catch so a quota error can't convert a successful fetch into a user-visible error; add a TTL/version to `jq.transcripts.v2` (also needed by WS4).
7. Minor polish batch: fa-only study view suppressed sentence mode, shared `trStatus` spinner race, Eastern Arabic digits for ar/ur markers.

**Files:** `web/src/pages/Reader.jsx`, `web/src/lib/transcribe.js`, `web/src/lib/settings.js`, `web/src/components/Drawer.jsx`, `backend/server.mjs`.

---

### WS3 — Decide the i18n story — **Effort: S (delete) / M (wire in)** — *Blocked on: owner decision.*

**Why:** The UI is hardcoded English for a Persian-first audience, while an 820-line 12-language dictionary and `LanguagePicker` ship as dead code (~30KB). The current state is contradictory either way.

**Steps:** Either (a) delete `translations.js` + `LanguagePicker.jsx` and commit to English UI, or (b) wire `DICT` into `t()`, backfill the ~64 missing newer Reader keys per language (at minimum for `fa`), and un-pin `document` lang/dir.

**Files:** `web/src/lib/i18n.jsx`, `web/src/lib/translations.js`, `web/src/components/LanguagePicker.jsx`.

---

### WS4 — Make offline actually work — **Effort: L** — *Blocked on: nothing (delta-sync nudge lands with the invoice).*

**Why:** After a full ~6GB download, the app still cannot launch offline (no app-shell caching, `/data/*.json` never seeded) and cached audio likely won't play on iOS/Safari (no Range/206 handling) — the exact environment offline exists for. The Downloads page currently over-promises.

**Steps:**
1. Precache the app shell (index.html, `/assets`) with versioned activation, and seed `/data/*.json` (surah index, surah JSONs, registries) during download-all.
2. Range-aware `respondWith` in the SW audio branch: slice cached ArrayBuffer, return 206 with `Content-Range`.
3. Quota preflight (`storage.estimate()` vs payload) before starting; stop on first `QuotaExceededError` with an explanation instead of burning the remaining gigabytes.
4. Delta-sync nudge: persist manifest count/hash at completion; surface "new content available (N files)" on the Downloads page — otherwise every pre-invoice downloader silently lacks all TTS audio forever.
5. Embedded-mode detection (`window.self !== window.top`): hide/redirect the 6GB flow inside the yquran.com iframe (partitioned, ITP-evictable storage); add an install affordance / A2HS hint for standalone.
6. Honest failures: stop counting failed files as progress in `downloadSurah`; surface why.
7. Small fixes: share the cache-name constant between `sw.js` and `downloads.js`; `e.waitUntil` the transcript-refresh put; metered-network check before auto-resume; clear a wedged `DL_FLAG` on persistent failure; handle orphaned files on reciter switch; delete `web/dist-quranner/`.

**Files:** `web/public/sw.js`, `web/src/lib/downloads.js`, `web/src/pages/Downloads.jsx`, `web/src/lib/data.js`, `web/src/main.jsx`.

---

### WS5 — Owner's audio model: versions, voices, and the seg-TTS pipeline — **Effort: L** — *Blocked on: ElevenLabs invoice (TTS/meaning), owner's long-audio capture (long tafsir).*

**Why:** The owner's four asks (short/long/meaning version chooser, 4-voice chooser, long-tafsir audio, AI-meaning audio) have zero code or data-model footprint. The registry schema must change **before** more content is laid down in the current single-pattern tree.

**Steps:**
1. **Data model first:** extend `tafsirs.json` to `versions[]` per tafsir (short/long/meaning), each with its own audio/transcript patterns; fix the stale metadata while there (`transcript.available:false` is wrong; the pattern is missing the language segment).
2. **Seg-TTS batch driver:** mirror `batch-transcribe.mjs` over segments to pre-generate the ~6,100 Fatiha sentence clips (67 segs × 7 ayahs × 13 langs) once billing clears — without this, payment does not restore Listen.
3. **Orphaned assets:** decide the 49 already-paid full-ayah mp3s — wire the unused `getTtsUrl` as a Listen fallback when seg clips are absent, or delete the dead export and the files.
4. **UI:** version chooser + voice chooser in the Reader header; replace the hardcoded `'bazargan'` in `tafsir.js`.
5. Ingest long-tafsir audio into the new `versions[]` tree when the owner delivers the capture.

**Files:** `web/public/data/tafsirs.json`, `web/src/lib/tafsir.js`, `web/src/lib/tts.js`, `web/src/pages/Reader.jsx`, `backend/batch-transcribe.mjs` (new sibling script), `backend/server.mjs`.

---

### WS6 — Coverage beyond Fatiha — **Effort: L** — *Blocked on: invoice (STT/translation costs), WS5 schema.*

**Why:** Surahs 2+ transcripts have text but no sentence segments, and no runnable pipeline exists to create them — extending coverage now would yield text blobs with non-functional Listen. Regenerating base data would also silently delete the six existing Fatiha translation sets.

**Steps:**
1. Turn the Fatiha curation step (segmentation + `claude-translation` upload with `replace:true`) into a runnable, repo-committed script.
2. Fix `scripts/build-data.py` to preserve/emit the `t{}` translation maps so regeneration is safe; then extend per-ayah translations (start with the 6 languages that have Fatiha data, decide on the other 6 per WS2 step 5).
3. Extend the backfill surah-by-surah (transcripts → segments → seg-TTS via the WS5 driver), updating the WS2 client scope gate as coverage lands.
4. Verify the suspected double-bismillah with everyayah reciters by ear; if confirmed, skip `playBasmala` for non-app reciters.

**Files:** `scripts/build-data.py`, `backend/batch-transcribe.mjs`, `backend/server.mjs`, `web/src/pages/Reader.jsx`, `web/public/data/surah/*.json`.

---

### WS7 — iOS app to the store — **Effort: L** — *Blocked on: Apple Developer account + OAuth credentials (owner).*

**Why:** Submission is impossible today (no team, stock Capacitor icon/splash — a Guideline 2.3.8 rejection), sign-in is unshippable (placeholder Google URL scheme, empty client IDs, no Apple entitlement — Guideline 4.8 requires working Sign in with Apple alongside Google), and native API calls would fail anyway because CORS omits the real WKWebView origin.

**Steps (unblocked now):**
1. **CORS:** make `NATIVE_ORIGIN` a Set including `capacitor://localhost` (the real iOS origin) alongside `https://localhost` (Android); fix the false comment in `capacitor.config.ts` that caused this; remove the stale `armv7` capability.
2. **Assets:** build real AppIcon + Splash from the existing `web/public/icon-512.png` art.
3. **Native downloads decision:** the Filesystem downloader is claimed but unimplemented and the SW doesn't run in WKWebView — either implement it for real or hide the Downloads UI on native; verify nginx sends `Access-Control-Allow-Origin` on the static media paths.
4. **Background audio decision:** add `UIBackgroundModes: audio` + AVAudioSession category, or accept playback stopping on screen lock (audio-first app — decide deliberately).
5. Commit `.env` templates so fresh clones don't silently build with inert sign-in.

**Steps (once owner delivers):**
6. Signing team in Xcode; Google iOS client ID + URL scheme; Apple sign-in entitlement file; TestFlight.
7. Store prep: privacy policy URL, App Privacy questionnaire (accounts, comments, speech recognition), export compliance, version-bump mechanism.

**Files:** `backend/server.mjs`, `web/capacitor.config.ts`, `web/ios/App/App/Info.plist`, `web/ios/App/App/Assets.xcassets/*`, `web/ios/App/App.xcodeproj/project.pbxproj`, `web/.env.capacitor`.

---

### WS8 — Deploy & ops hardening — **Effort: M** — *Blocked on: off-site backup destination (owner).*

**Why:** Deploy is a memorized root rsync with three build flavors sharing one `dist/` (wrong-flavor deploys are silent; the iOS synced bundle has already drifted), there is no backend deploy command at all, and the single production box has zero monitoring and no off-site backup of irreplaceable user data and paid-for media.

**Steps:**
1. Per-target build scripts with distinct `--outDir`s (`dist-web` / `dist-quranner` / `dist-capacitor`), each rsyncing the right directory and recording the deployed git rev; add a backend deploy command; consider `--delete` for hashed assets.
2. Nightly restic/rsync of `/srv` (users, comments, transcripts, tafsir-tts, media) and `/var/www` to off-box storage; document restore.
3. Free uptime monitor on `/api/health` and both vhosts.
4. Backend robustness leftovers: AbortController timeouts on all outbound fetches (JWKS/ElevenLabs/Anthropic); settle `readBody` on `close`; evict stale rate-limit map entries; filter `.bak` files from `/api/manifest` (they're currently downloaded into users' offline caches).
5. Fix or retire `joow.app.yaml` (wrong outputDir, `enabled: false` for a live app).
6. Wire the app into repo CI once committed (WS1).

**Files:** `docs/HANDOFF.md`, `web/vite.config.ts`, `backend/server.mjs`, `joow.app.yaml`, `.github/workflows/`.

---

## 4. Owner-only inputs needed

1. **Pay the ElevenLabs invoice** — but only after WS2's client scope gate ships, to avoid the paid fan-out.
2. **Long-tafsir audio capture** — the network capture from the source hosts; unrecoverable if those hosts die, so treat as time-sensitive.
3. **Apple Developer account** ($99/yr) — unblocks signing, entitlements, TestFlight, and store submission.
4. **OAuth credentials** — Google iOS client ID (for the URL scheme) and Apple Service ID / Sign in with Apple configuration; current env values are empty.
5. **Privacy policy URL + store metadata** — required for App Review; also the App Privacy questionnaire answers.
6. **Off-site backup destination** — a storage box or bucket for nightly `/srv` backups.
7. **Two product decisions:** i18n (wire the 12-language dictionary in, or delete it — WS3) and the reading-language list (trim to languages with data, or fund the missing 6 — WS2/WS6).