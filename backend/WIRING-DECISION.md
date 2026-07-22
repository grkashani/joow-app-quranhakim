# Legacy-clip acceptance — DECIDED: `keep` (2026-07-21)

> **RESOLVED.** The owner chose **`keep`** ("everything as recommended"). The
> dual-read bridge is now built and tested (`store/legacy-bridge.mjs`,
> `store/layout.mjs` `parseClipKey`, generator `resolveAcceptable` gate — 108
> backend tests green). A normal page load never re-derives a clip that already
> exists on disk (first wire = $0); quality improves only on an explicit override,
> which the quality gate judges. `legacyAcceptance:'rederive'` remains available
> as an opt-in bulk-upgrade lane. The remaining work is the review-gated wiring
> into `server.mjs` (needs the bootstrap/logic split first). The original
> decision write-up is kept below for the record.

---

# One decision blocks the wiring: legacy-clip acceptance

The provider/store/job layer + `layout.mjs` are built and tested (92 backend
tests). Everything downstream of here is the **dual-read bridge** that lets the
new versioned store sit over the existing flat `/srv` tree — and it hinges on one
policy call that costs real money to get wrong. I did NOT decide it for you.

## The layout, as it exists today (pinned by `layout.test.mjs`)

One flat file per clip, overwritten on regeneration, served directly by nginx:

| kind | legacy path | served URL |
|---|---|---|
| stt | `/srv/transcripts/<id>/<lang>/<c3>/<c3>_<c3>.json` | `/transcripts/…` |
| tafsir | `/srv/tafsir-tts/<id>/<lang>/<c3>/<c3>_<c3>.mp3` | `/tafsir-tts/…` |
| tafsir-seg | `…/<c3>_<c3>.seg<i>.mp3` | `/tafsir-tts/…` |
| meaning | `/srv/meaning-tts/<lang>/<c3>/<c3>_<c3>[.noann].mp3` | `/meaning-tts/…` |

Each `.mp3` already has `.words.json` + `.gen.json` provenance beside it, written
atomically (tmp→rename). ~20k clips + 6 GB of source recitation already live here.
`layout.describe({kind,id,lang,s,a})` returns `{clipKey, legacyPath, url, words, gen}`
— the bridge's whole vocabulary.

## The fork

The versioned store keys a clip by a **content hash** of `(kind, provider, model,
PIPELINE_VERSION, sourceSha)`. A legacy clip was made by *some older* provider/
pipeline whose hash we don't have. So when the generator asks
`store.has(clipKey, currentHash)`, a legacy clip is a **miss** — and a naive wire
would regenerate all 20k paid clips on first read. The bridge exists to stop that.
The question is what "stop that" means:

**Option A — Keep & upgrade (recommended, cheap + safe).**
`has()` is hash-agnostic for legacy presence: if the legacy file exists, treat the
clip as already-generated and keep serving it at its current URL. Never
auto-regenerate. A *better* version is only ever added by an **explicit** re-run
(reciter override / quality pass), and the `promote()` quality gate decides whether
it becomes current. → First wire = **$0**, zero risk, and quality still improves on
demand. Matches your "whisper now, elevenlabs later, always able to improve"
intent without a surprise bill.

**Option B — Always re-derive to current pipeline.**
Treat legacy as absent; regenerate everything to the newest provider/PIPELINE_VERSION
on read. → Uniformly "latest", but the first wire re-pays for 20k clips (real
ElevenLabs/Whisper cost) and leans on the FATIHA-only scope gate to stay safe.

## Recommendation

**Option A**, encoded as the default of a `legacyAcceptance: 'keep' | 'rederive'`
flag on the bridge, with a separate, explicitly-budgeted batch lane for bulk
quality upgrades (Option B behavior on demand, never as a side effect of a page load).
That's the lossless-but-cheap posture: nothing regenerates by accident, everything
can be upgraded deliberately.

## Why I stopped here

`layout.mjs` was a safe, obviously-correct extraction of pure functions, so I built
and tested it. The bridge embeds *this* decision plus a live-`/srv` read path, and
wiring it touches the production backend — both past the "additive + reversible, no
risky change without review" line I'm holding to. One word from you (`keep` or
`rederive`) turns the morning's wiring review into a ratification instead of a
design session. Everything needed to build it the moment you decide is already in
`layout.mjs` + `store/` + `job/generate.mjs`.
