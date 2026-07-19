# Quran Hakim — Audio Asset Architecture v2 ("pay once, use forever")

_Research-verified 2026-07-19 against live ElevenLabs docs/pricing (6-agent research pass,
all consequential claims spot-checked). This is the design the owner asked for before
authorizing ElevenLabs spend beyond Fatiha._

## 1. Verified facts that drive the design

**Billing has two rails, ~2× apart.**
- Subscription credits: Creator $22/121k cr … Pro $99/600k … Business $990/6M. Effective
  **$165–182 per 1M chars**. STT through credits ≈ $3.27/hr — never do this.
- **ElevenAPI pay-as-you-go (USD)**: TTS **$100/1M chars** (eleven_v3, multilingual_v2),
  **$50/1M** (flash_v2_5). STT Scribe v2 **$0.22/audio-hour**. Forced alignment: same rate
  as STT. → All volume work should go through the API rail if the account has it.

**Persian is captive to eleven_v3.** multilingual_v2 (29 langs) and flash_v2_5 (32) do NOT
include Farsi; only eleven_v3 (70+) does. v3 = 1 credit/char, **5,000-char request limit**,
and **request stitching is NOT available on v3** (verbatim in docs) — so long Persian texts
are chunked with `previous_text`/`next_text` as the only (undocumented-effect) continuity
hint. The other 7 UI languages CAN use flash_v2_5 at half price (quality must be piloted).

**What every paid call returns vs what we keep today** (audit of `server.mjs`):
we currently persist only `{words, dur, text}`. We DISCARD: the raw char-level `alignment`,
the entire `normalized_alignment` (what was actually spoken after normalization), chunk
boundaries (which chunk → which byte/time range), the `request-id` and **`character-cost`
response headers** (per-request credit cost — free cost ledger!), voice_id/model/settings/
text-hash provenance (why voice changes require manual cache deletion), and on STT:
detected language + probability, per-word confidence (logprob), spacing tokens.
Consequences today: fixing a transcript typo never propagates (cache gates on file
existence, not text hash); changing sentence segmentation invalidates every positional
`segN.mp3`; changing a voice requires manual tree deletion.

**Forced alignment** (`POST /v1/forced-alignment`, multipart `file` + `text`): returns
char- AND word-level timings + per-word confidence ("loss"). Same price as STT. Supports
**Arabic but NOT Persian** (multilingual_v2 language set). → usable to re-align corrected
non-Persian transcripts; Persian re-alignment = re-STT (Scribe supports 90+ langs incl fa).

**Free recitation word timings** cover ~13 of our 19 reciters: cpfair/quran-align (CC BY
4.0; Alafasy, Husary, Abdul Basit Murattal + others), Tarteel **QUL** (qul.tarteel.ai;
adds Ghamadi, Maher, Tunaiji, Dussary; JSON/SQLite), quran.com API v4 (live word segments,
audio byte-identical to everyayah — verified). Uncovered (Ajamy, Hudhaify, AbdulSamad,
Yaser Salamah + 2): self-hosted aligner (free) or EL forced-alignment for Arabic ($0.22/hr).

## 2. Whole-Quran cost table (API rail, 6,236 ayahs; refine with a pilot)

| Content | chars/lang | fa (v3 $100/1M) | other lang (flash $50/1M) |
|---|---|---|---|
| Meaning (~200 c/ayah) | 1.25M | **$125** | $62 |
| Short tafsir (~1.8k c/ayah) | 11.2M | **$1,122** | $561 |
| Long tafsir (~5k c/ayah) | 31.2M | **$3,118** | $1,559 |
| STT whole corpus (short+long, 675 hrs) | — | **~$149 once** (not per language) | — |

Scenarios: fa+en meaning+short ≈ **$1.9–2.1k** · everything-everywhere sane mix ≈ **$20k**
(all-v3 ceiling $35k; via subscription credits ~$58k — non-starter).

## 3. The design

### A. Provenance-first capture (`.gen.json` sidecar per clip)
Every synthesis stores, next to the mp3: exact input text + sha256, voice_id, model_id,
voice_settings, language_code, seed, output_format, **chunk map**
`[{textRange, byteRange, timeOffsetSec, requestId, characterCost}]`, **raw `alignment` AND
`normalized_alignment`** (char-level), createdAt, total credits. `words.json` remains the
tiny derived view the reader loads; everything else makes future features **offline
re-derivations** instead of re-purchases. STT transcripts likewise keep language,
language_probability, per-word logprob, and are written with a text sha.

### B. Content-addressed caching + staleness
Clip identity = `sha256(spokenText | voiceId | modelId | settingsJson)`. `clipReady`
compares the stored hash to the current inputs → transcript fixes and voice changes
auto-regenerate exactly the affected clips; nothing else. Sentence clips die as separate
files: segments become a **derived index over the full-clip char alignment** (cut points,
not audio), so re-segmentation costs $0 forever.

### C. Segment anchors = cross-language equivalence
Canonical transcript = ordered **segments** (sentences) with stable IDs (`s1a1-seg004`).
**Translations are performed per-segment (1:1)** so every language shares segment IDs.
From char alignment we derive per-language `{segId → timeRange, wordRange}` (`anchors.json`).
This is what "always know where text equals audio across languages" means concretely:
- Language switch v3: jump to the **same sentence** (not proportional time).
- Sentence prev/next/loop; "repeat this sentence"; per-sentence GPT explain.
- Fatiha's existing free-form translations get retro-aligned by agents later; all new
  surahs are translated segment-wise natively.

### D. Playback navigation (zero marginal cost)
Word-tap seek (shipped), sentence stepping, ayah stepping (shipped), **backward play** =
reverse navigation through ayahs/sentences/words with each unit playing forward (reversed
raw audio is unintelligible; a true reversed-audio effect is a client-side WebAudio trick
on already-cached files if ever wanted). Memorization loops (A-B repeat) fall out of the
same timing data.

### E. Recitation karaoke — free
Import QUL/quran-align word segments for the ~13 covered reciters (license: CC BY 4.0 /
per-resource; attribute in About). Remaining reciters via self-hosted forced alignment or
EL Arabic forced-alignment at $0.22/hr. No ElevenLabs TTS involved.

### F. STT-first, TTS-lazy
1. **STT the entire Bazargan corpus once (~$149)** with full capture (words + confidences,
   `tag_audio_events=false` for alignment-clean output). This banks transcripts + timings
   for every future feature, decoupled from TTS.
2. TTS stays **get-or-create lazy** per (surah, language, content) — already implemented —
   plus owner-approved batch pre-generation per scope (e.g. "Yasin+Kahf+Juz ʿAmma in fa+en").

### G. Cost governance
- Read the **`character-cost` header on every call** → append to `/srv/usage-ledger.ndjson`
  `{ts, endpoint, clip, chars, credits, model, voice}`; expose `/api/usage` summary.
- `EL_DAILY_BUDGET` env: generation refuses (503 not_ready) once the day's ledger exceeds it.
- Scope gates replace the Fatiha-only flag: an allowlist of (surah range × lang × content)
  the owner has approved; everything else 503s honestly.
- Pilot rule: before any bulk run, 1–2 surahs are generated and auditioned (chars/ayah and
  quality calibration); the cost model scales linearly from the pilot's real numbers.

### H. Voice policy
Voice IDs are frozen per language in provenance; changing one is a deliberate, costed
re-generation (now auto-detected via hashes). Optional future: ElevenLabs Professional
Voice Cloning could reproduce Bazargan's own voice for Persian tafsir — **only with
explicit rights/consent from the rights holder** (ElevenLabs policy requires it; so do we).

## 4. Recommended rollout (owner decision points)

| Phase | What | Cost | Unlocks |
|---|---|---|---|
| 0 (now) | Implement A–D capture code; import free recitation timings (E); **STT whole corpus**; pilot 2 surahs fa-v3 + en-flash/v3 A/B | ~**$150–190** | transcripts+timings banked forever; real cost calibration; recitation karaoke for 13 reciters |
| 1 | Persian whole-Quran **meaning + short** on v3 | ~**$1,250** | complete fa experience, every surah |
| 2 | English **meaning + short** on flash (or v3 if pilot prefers) | ~**$620–1,250** | complete en experience |
| 3+ | Other languages on demand (segment-translated first); **long tafsir stays lazy** — pre-gen only owner-picked surahs | per scope | controlled spend, usage-driven |

Long-tafsir full pre-generation ($3.1k/lang fa, $1.6k others) is deliberately deferred
until listening data justifies it — lazy get-or-create already serves any ayah a user
actually opens.
