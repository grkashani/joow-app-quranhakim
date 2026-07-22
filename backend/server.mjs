// JoowQuran transcription API.
// GET /api/transcript?tafsir=&surah=&ayah=&lang=
//   Get-or-create a transcript for a tafsir clip in the requested language.
//   Original language -> ElevenLabs Scribe (STT) on the local audio file.
//   Other language     -> translate the original (pluggable; Anthropic if configured).
//   Everything is persisted to /srv/transcripts (a shared cache), so each clip is
//   transcribed/translated ONCE and reused for every future user, in every language.
//
// The static cache is served directly by nginx at /transcripts/... — this API is only
// hit on a cache miss (to generate), then subsequent reads are static + instant.
import http from 'node:http'
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createLayout } from './store/layout.mjs'
import { createArtifactStore } from './store/artifact-store.mjs'
import { recordGeneratedClip } from './store/record.mjs'

const PORT = Number(process.env.PORT || 8787)
const EL_KEY = process.env.ELEVENLABS_API_KEY || ''
// Optional SEPARATE key for exact-meaning TTS only (owner 2026-07-19: burn the
// stranded Creator-plan credits on surah-2 meaning). Tafsir/STT stay on EL_KEY.
const EL_KEY_MEANING = process.env.ELEVENLABS_API_KEY_MEANING || ''
const EL_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v2'
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ''
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'claude-haiku-4-5-20251001'
const WEBROOT = process.env.WEBROOT || '/var/www/quranner'
const SRV = process.env.SRV_ROOT || '/srv'
const TRANSCRIPTS = process.env.TRANSCRIPTS_DIR || '/srv/transcripts'
const TTS_DIR = process.env.TTS_DIR || '/srv/tafsir-tts'
const COMMENTS_DIR = process.env.COMMENTS_DIR || '/srv/comments'
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || ''
const EL_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_v3'
const EL_TTS_FMT = process.env.ELEVENLABS_TTS_OUTPUT_FORMAT || 'mp3_44100_128'

// ---- Lossless provenance store (opt-in: USE_PROVIDER_LAYER=1) ----
// When enabled, every FRESHLY-generated clip is ALSO recorded as a versioned,
// content-hashed artifact (word-timing + provenance sidecars + a pointer to the
// served URL) under ARTIFACT_ROOT — the "never lose / always improve" history.
// This does NOT change anything served: the canonical mp3 stays on its flat /srv
// path (served by nginx). It is BEST-EFFORT — a store error is logged and ignored,
// never blocking or failing generation. Flag off (default) = byte-identical to before.
const USE_PROVIDER_LAYER = process.env.USE_PROVIDER_LAYER === '1'
const ARTIFACT_ROOT = process.env.ARTIFACT_ROOT || path.join(SRV, 'artifacts')
const _layout = createLayout({ SRV, TRANSCRIPTS, TTS_DIR, MEANING_DIR: process.env.MEANING_DIR || '/srv/meaning-tts' })
const _artifacts = USE_PROVIDER_LAYER ? createArtifactStore({ root: ARTIFACT_ROOT }) : null
async function recordClip(args) {
  if (!_artifacts) return
  try { await recordGeneratedClip(_artifacts, _layout, args) }
  catch (e) { console.error('[artifact-record] skipped:', e?.message || e) }
}

// ---- Auth: Apple + Google sign-in, HS256 sessions, file-based user store ----
const SESSION_SECRET = process.env.SESSION_SECRET || ''                       // SECRET — openssl rand -hex 32
const SESSION_TTL_S = Number(process.env.SESSION_TTL_S || 7 * 24 * 60 * 60)   // 7 days (was 30; verdict #12/#14)
const USERS_DIR = process.env.USERS_DIR || '/srv/users'
const SESSION_TOKEN_MAX = Number(process.env.SESSION_TOKEN_MAX || 4096)       // reject oversized tokens (verdict #17)

// Apple audiences (both platforms): web Services ID + iOS bundle id. Public identifiers.
const APPLE_SERVICE_ID_WEB = process.env.APPLE_SERVICE_ID_WEB || ''           // public — e.g. com.joow.quran.web
const APPLE_CLIENT_ID_IOS = process.env.APPLE_CLIENT_ID_IOS || 'com.joow.quran' // public — bundle id
const APPLE_AUDS = new Set([APPLE_SERVICE_ID_WEB, APPLE_CLIENT_ID_IOS].filter(Boolean))

// Google audiences: web client id + iOS client id. Public identifiers.
const GOOGLE_CLIENT_ID_WEB = process.env.GOOGLE_CLIENT_ID_WEB || ''           // public — ...apps.googleusercontent.com
const GOOGLE_CLIENT_ID_IOS = process.env.GOOGLE_CLIENT_ID_IOS || ''           // public — ...apps.googleusercontent.com
const GOOGLE_AUDS = new Set([GOOGLE_CLIENT_ID_WEB, GOOGLE_CLIENT_ID_IOS].filter(Boolean))

// Public web origin allowed to call auth from a browser + the native webview origin.
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'https://quranner.com'
const NATIVE_ORIGIN = process.env.NATIVE_ORIGIN || 'https://localhost'        // Capacitor iosScheme:'https'

const pad3 = (n) => String(n).padStart(3, '0')
const fill = (pat, s, a) =>
  pat.replaceAll('{c3}', pad3(s)).replaceAll('{v3}', pad3(a)).replaceAll('{c}', String(s)).replaceAll('{v}', String(a))

async function loadTafsirs() {
  const raw = await fs.readFile(path.join(WEBROOT, 'data', 'tafsirs.json'), 'utf8')
  return JSON.parse(raw).tafsirs || []
}
const cachePath = (id, lang, s, a) => path.join(TRANSCRIPTS, id, lang, pad3(s), `${pad3(s)}_${pad3(a)}.json`)
const readCache = async (p) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return null } }
async function writeCache(p, obj) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(obj)) }

// ---- Input hardening (security review 2026-07-19) ----
// `lang` flows into path.join → a crafted value ("../../etc/…") was an
// unauthenticated arbitrary file read/WRITE as the service user. Allowlist it.
const LANG_RE = /^[a-z]{2,8}(?:-[A-Za-z0-9]{2,8})?$/
const cleanLang = (v) => (typeof v === 'string' && LANG_RE.test(v) ? v : null)
const validSurah = (s) => Number.isInteger(s) && s >= 1 && s <= 114
const validAyah = (a) => Number.isInteger(a) && a >= 1 && a <= 300
// Curated-translation uploads may overwrite ONLY with the shared secret
// (CONTRIBUTE_SECRET env). Unset ⇒ replace is disabled entirely (fail closed).
const CONTRIBUTE_SECRET = (process.env.CONTRIBUTE_SECRET || '').trim()
// Content scope: generation is FATIHA-ONLY unless explicitly opened. Cached
// content still serves for every surah; this stops a client fan-out on surahs
// 2–114 from turning into paid ElevenLabs/translation calls the moment the
// billing account works again (the "cost bomb").
const SCOPE_ALL = process.env.ALLOW_ALL_SURAHS === '1'
// Additional surahs the OWNER has approved for MEANING generation only
// (comma-separated numbers). Tafsir stays Fatiha-gated regardless.
const MEANING_SURAHS_EXTRA = new Set(
  (process.env.MEANING_SURAHS_EXTRA || '').split(',').map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 114)
)
const fileExists = async (p) => { try { await fs.access(p); return true } catch { return false } }
const localAudioPath = (tafsir, s, a) => path.join(SRV, fill(tafsir.audio.pattern, s, a).replace(/^\//, ''))

// Scribe STT with replay annotations: word-level timestamps + audio-event tags.
// Returns { text, words } where words = [{ t, s, e, ev? }] (spacing entries dropped,
// times rounded to 10ms) — enables synced word-highlighting during audio replay.
async function elevenLabsSTT(audioPath, langCode) {
  const buf = await fs.readFile(audioPath)
  const form = new FormData()
  form.append('model_id', EL_MODEL)
  if (langCode) form.append('language_code', langCode)
  form.append('timestamps_granularity', 'word')
  form.append('tag_audio_events', 'true')
  form.append('diarize', 'false') // single narrator; diarization adds cost, no value here
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(audioPath))
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', headers: { 'xi-api-key': EL_KEY }, body: form,
  })
  if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const d = await res.json()
  const words = Array.isArray(d.words)
    ? d.words
        .filter((w) => w.type !== 'spacing')
        .map((w) => ({
          t: w.text,
          s: Math.round((w.start || 0) * 100) / 100,
          e: Math.round((w.end || 0) * 100) / 100,
          ...(w.type === 'audio_event' ? { ev: 1 } : {}),
          ...(typeof w.logprob === 'number' ? { lp: Math.round(w.logprob * 1000) / 1000 } : {}),
        }))
    : undefined
  // v2 capture: keep the detection metadata the paid call already returned.
  return {
    text: d.text || '', words,
    languageCode: d.language_code || null,
    languageProbability: typeof d.language_probability === 'number' ? d.language_probability : null,
  }
}

async function translate(text, from, to) {
  if (!ANTHROPIC_KEY) return null
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: TRANSLATE_MODEL, max_tokens: 4096,
      messages: [{ role: 'user', content: `Translate this Qur'an tafsir (commentary) passage from ${from} to ${to}. Preserve meaning faithfully and read naturally. Output ONLY the translation, no preamble.\n\n${text}` }],
    }),
  })
  if (!res.ok) throw new Error(`translate ${res.status}`)
  return (await res.json()).content?.[0]?.text?.trim() || null
}

const inflight = new Map()
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key)
  const p = fn().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

async function getOrCreate(tafsir, s, a, lang) {
  const origLang = tafsir.transcript?.lang || tafsir.language
  const p = cachePath(tafsir.id, lang, s, a)
  const cached = await readCache(p)
  if (cached) return cached
  return once(p, async () => {
    const origPath = cachePath(tafsir.id, origLang, s, a)
    let orig = await readCache(origPath)
    if (!orig) {
      const r = await elevenLabsSTT(localAudioPath(tafsir, s, a), origLang)
      orig = {
        text: r.text, lang: origLang, source: 'elevenlabs-scribe', model: EL_MODEL, createdAt: new Date().toISOString(),
        ...(r.words ? { words: r.words } : {}),
        ...(r.languageCode ? { detectedLang: r.languageCode, detectedProb: r.languageProbability } : {}),
      }
      await writeCache(origPath, orig)
    }
    if (lang === origLang) return orig
    const translated = await translate(orig.text, origLang, lang)
    if (translated == null) return { ...orig, requestedLang: lang, translated: false } // no translator configured
    const out = { text: translated, lang, source: 'translation', from: origLang, model: TRANSLATE_MODEL, createdAt: new Date().toISOString() }
    await writeCache(p, out)
    return out
  })
}

// ---- ElevenLabs Text-to-Speech (v3): translated tafsir AUDIO ----
// Per-language voice override: ELEVENLABS_VOICE_AR / _TR / … pick a NATIVE
// voice per language (see /voice-audition on quranner.com); fall back to the
// default voice. Changing a language's voice ⇒ delete its cached clips
// (/srv/tafsir-tts/bazargan/<lang>/…) and re-run seg-batch to regenerate.
const voiceFor = (langCode) =>
  (langCode && process.env[`ELEVENLABS_VOICE_${String(langCode).toUpperCase().replace(/-/g, '_')}`]) || EL_VOICE
async function ttsElevenLabs(text, langCode) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceFor(langCode))}?output_format=${EL_TTS_FMT}`
  const body = { text, model_id: EL_TTS_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }
  if (langCode) body.language_code = langCode
  const res = await fetch(url, { method: 'POST', headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!bytes.length) throw new Error('ElevenLabs TTS returned empty audio')
  return bytes
}
const ttsPath = (id, lang, s, a) => path.join(TTS_DIR, id, lang, pad3(s), `${pad3(s)}_${pad3(a)}.mp3`)

// A synthesized clip is only "ready" when BOTH the mp3 AND its word-timing sidecar
// (.words.json) exist. Clips made before the karaoke word-timing feature have the
// mp3 but no sidecar; treating those as a cache miss lets them self-heal (regenerate
// WITH timings) instead of serving un-highlightable audio forever.
const wordsSidecar = (abs) => abs.replace(/\.mp3$/, '.words.json')
const clipReady = async (abs) => (await fileExists(abs)) && (await fileExists(wordsSidecar(abs)))

// ElevenLabs caps a single TTS request at 5000 chars. Split long tafsir text into
// sentence-aligned chunks; the concatenated MP3 frames play back as one clip.
const EL_TTS_MAX = Number(process.env.ELEVENLABS_TTS_MAX_CHARS || 4500)
function chunkForTts(text, max = EL_TTS_MAX) {
  const t = String(text || '').trim()
  if (t.length <= max) return t ? [t] : []
  const out = []
  let buf = ''
  for (const part of t.split(/(?<=[.!?…۔؟\n])\s+/)) {
    if (!part) continue
    if (part.length > max) {                 // one giant sentence: hard-split
      if (buf) { out.push(buf.trim()); buf = '' }
      for (let i = 0; i < part.length; i += max) out.push(part.slice(i, i + max))
    } else if ((buf ? buf.length + 1 : 0) + part.length > max) {
      if (buf) out.push(buf.trim()); buf = part
    } else buf = buf ? `${buf} ${part}` : part
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}
async function ttsSynthesize(text, lang) {
  const chunks = chunkForTts(text)
  if (!chunks.length) throw new Error('no transcript text to synthesize')
  const parts = []
  for (const c of chunks) parts.push(await ttsElevenLabs(c, lang)) // sequential: keep call order + rate
  return Buffer.concat(parts)
}

// ---- TTS WITH WORD TIMINGS (for live word-by-word "karaoke" reading) ----
// ElevenLabs /with-timestamps returns per-character start/end seconds; we group
// them into words. Costs the same as normal TTS. A words[] sidecar is saved next
// to the mp3 so the reader can highlight the spoken word + auto-scroll.
//
// v2 CAPTURE (docs/AUDIO-ASSET-DESIGN.md): everything the paid call returns is
// KEPT — both raw alignments (`alignment` = timings against the input text,
// `normalized_alignment` = against what was actually spoken), plus the
// `request-id` and `character-cost` response headers. The synthesizers below
// assemble these into a per-clip `.gen.json` provenance sidecar, and every call
// is appended to the usage ledger — so future features derive from stored data
// instead of re-paying, and "what did this cost" is a query.
const TTS_VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75 }
const USAGE_LEDGER = process.env.USAGE_LEDGER || '/srv/usage/ledger.ndjson'
// Hard daily spend ceiling in credits (0/unset = no cap). When the day's ledger
// total reaches it, synthesis refuses with a 503 — the reader skips with its
// honest note instead of silently spending (design §G).
const EL_DAILY_BUDGET = Number(process.env.EL_DAILY_BUDGET || 0)
async function ledger(entry) {
  try {
    await fs.mkdir(path.dirname(USAGE_LEDGER), { recursive: true })
    await fs.appendFile(USAGE_LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch { /* ledger is best-effort — never blocks synthesis */ }
}
async function readLedger() {
  try {
    return (await fs.readFile(USAGE_LEDGER, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
let _spendCache = { at: 0, today: 0 }
async function todayCredits() {
  if (Date.now() - _spendCache.at < 30_000) return _spendCache.today
  const day = new Date().toISOString().slice(0, 10)
  const today = (await readLedger()).filter((e) => (e.ts || '').startsWith(day)).reduce((t, e) => t + (e.characterCost || e.chars || 0), 0)
  _spendCache = { at: Date.now(), today }
  return today
}
async function assertBudget() {
  if (!EL_DAILY_BUDGET) return
  if ((await todayCredits()) >= EL_DAILY_BUDGET) {
    const err = new Error(`daily ElevenLabs budget (${EL_DAILY_BUDGET} credits) reached`)
    err.statusCode = 503
    throw err
  }
}
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const packAlignment = (a) => (a && a.characters ? {
  characters: a.characters,
  starts: a.character_start_times_seconds,
  ends: a.character_end_times_seconds,
} : null)
async function ttsElevenLabsTimed(text, langCode, apiKey = EL_KEY) {
  await assertBudget()
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceFor(langCode))}/with-timestamps?output_format=${EL_TTS_FMT}`
  const body = { text, model_id: EL_TTS_MODEL, voice_settings: TTS_VOICE_SETTINGS }
  if (langCode) body.language_code = langCode
  const res = await fetch(url, { method: 'POST', headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`ElevenLabs TTS(ts) ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const requestId = res.headers.get('request-id') || null
  const characterCost = Number(res.headers.get('character-cost')) || null
  const j = await res.json()
  const mp3 = Buffer.from(j.audio_base64 || '', 'base64')
  if (!mp3.length) throw new Error('ElevenLabs TTS(ts) returned empty audio')
  const a = j.alignment || {}
  await ledger({ kind: 'tts', model: EL_TTS_MODEL, voice: voiceFor(langCode), lang: langCode || null, chars: text.length, characterCost, requestId, key: apiKey === EL_KEY ? 'main' : 'meaning' })
  return {
    mp3,
    chars: a.characters || [], starts: a.character_start_times_seconds || [], ends: a.character_end_times_seconds || [],
    alignment: packAlignment(j.alignment), normalizedAlignment: packAlignment(j.normalized_alignment),
    requestId, characterCost,
  }
}
// Group per-character alignment into words [{ w, s, e }] (seconds), shifted by `offset`.
function charsToWords(chars, starts, ends, offset = 0) {
  const words = []; let cur = '', s = null, e = 0
  const flush = () => { if (cur.trim()) words.push({ w: cur, s: +((s ?? 0) + offset).toFixed(3), e: +(e + offset).toFixed(3) }); cur = ''; s = null }
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (/\s/.test(c)) flush()
    else { if (s === null) s = starts[i] ?? 0; cur += c; e = ends[i] ?? e }
  }
  flush()
  return words
}
// TTS + word timings. Concatenates chunk audio and offsets each chunk's word
// times by the running audio duration so timings stay aligned across chunks.
// Returns `gen` — the full v2 provenance (chunk map with raw alignments,
// request ids, per-chunk credit cost) for the caller to persist as .gen.json.
async function ttsSynthesizeTimed(text, lang, apiKey = EL_KEY) {
  const chunks = chunkForTts(text)
  if (!chunks.length) throw new Error('no transcript text to synthesize')
  const parts = []; let words = []; let offset = 0; let byteOffset = 0
  const chunkMeta = []
  for (const c of chunks) {
    const r = await ttsElevenLabsTimed(c, lang, apiKey)
    parts.push(r.mp3)
    words = words.concat(charsToWords(r.chars, r.starts, r.ends, offset))
    chunkMeta.push({
      text: c, chars: c.length,
      timeOffsetSec: +offset.toFixed(3), byteOffset, bytes: r.mp3.length,
      requestId: r.requestId, characterCost: r.characterCost,
      alignment: r.alignment, normalizedAlignment: r.normalizedAlignment,
    })
    byteOffset += r.mp3.length
    offset += (r.ends.length ? r.ends[r.ends.length - 1] : 0)
  }
  const gen = {
    v: 2, capture: 'full',
    text, textSha256: sha256(text), lang: lang || null,
    voiceId: voiceFor(lang), modelId: EL_TTS_MODEL,
    voiceSettings: TTS_VOICE_SETTINGS, outputFormat: EL_TTS_FMT,
    createdAt: new Date().toISOString(),
    credits: chunkMeta.reduce((t, c) => t + (c.characterCost || c.chars), 0),
    chunks: chunkMeta,
  }
  return { mp3: Buffer.concat(parts), words, dur: +offset.toFixed(3), gen }
}

// Per-sentence clip path: one MP3 per transcript segment (same tree as full-ayah TTS).
const ttsSegPath = (id, lang, s, a, idx) => path.join(TTS_DIR, id, lang, pad3(s), `${pad3(s)}_${pad3(a)}.seg${idx}.mp3`)

// Get-or-create the TTS clip for ONE transcript segment (sentence). Reads the segment
// text from the cached transcript JSON (segments:[{s,e,text}]). [audio-tags] are KEPT
// by default — ElevenLabs v3 reads them for tone — and only stripped on a retry if
// the API errors on the tagged text. Cost is paid once ever (disk cache + once() dedup).
async function getOrCreateSegTts(tafsir, s, a, lang, idx) {
  const abs = ttsSegPath(tafsir.id, lang, s, a, idx)
  const rel = `/tafsir-tts/${tafsir.id}/${lang}/${pad3(s)}/${pad3(s)}_${pad3(a)}.seg${idx}.mp3`
  if (await clipReady(abs)) return { ok: true, url: rel, cached: true }
  return once('tts-seg:' + abs, async () => {
    const tr = await readCache(cachePath(tafsir.id, lang, s, a))
    const seg = Array.isArray(tr?.segments) ? tr.segments[idx] : undefined
    const text = String(seg?.text || '').trim()
    if (!text) { const err = new Error(`no segment text at idx ${idx} for ${tafsir.id}/${lang}/${s}:${a}`); err.statusCode = 400; throw err }
    let mp3, words, dur, gen, said = text
    try { ({ mp3, words, dur, gen } = await ttsSynthesizeTimed(text, lang)) }
    catch (e) {
      const stripped = text.replace(/\[[^\][]*\]/g, ' ').replace(/\s+/g, ' ').trim()
      if (stripped === text || !stripped) throw e
      ;({ mp3, words, dur, gen } = await ttsSynthesizeTimed(stripped, lang)); said = stripped // retry without [audio-tags]
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp-${process.pid}`
    await fs.writeFile(tmp, mp3); await fs.rename(tmp, abs) // atomic
    // Word-timing sidecar for live karaoke highlight (same path, .words.json).
    await fs.writeFile(abs.replace(/\.mp3$/, '.words.json'), JSON.stringify({ words, dur, text: said })).catch(() => {})
    // v2 provenance sidecar (raw alignments + request ids + credits).
    await fs.writeFile(abs.replace(/\.mp3$/, '.gen.json'), JSON.stringify({ ...gen, kind: 'tafsir-seg', tafsir: tafsir.id, surah: s, ayah: a, segIdx: idx })).catch(() => {})
    await recordClip({ kind: 'tafsir-seg', id: tafsir.id, lang, s, a, seg: idx, provider: 'elevenlabs-tts', model: EL_TTS_MODEL, sourceText: said, extra: { credits: gen?.credits }, sidecars: { 'words.json': JSON.stringify({ words, dur, text: said }), 'gen.json': JSON.stringify(gen) } })
    return { ok: true, url: rel, cached: false }
  })
}

// Ensure the translated transcript exists, then TTS it once. Persisted + shared (get-or-create).
async function getOrCreateTts(tafsir, s, a, lang) {
  const abs = ttsPath(tafsir.id, lang, s, a)
  const rel = `/tafsir-tts/${tafsir.id}/${lang}/${pad3(s)}/${pad3(s)}_${pad3(a)}.mp3`
  if (await clipReady(abs)) return { url: rel, cached: true }
  // COST GUARD: sentence clips are the single canonical synthesis (each language's
  // text is paid for exactly once). Full-ayah synthesis would duplicate that cost,
  // so it is disabled unless explicitly re-enabled.
  if (process.env.ELEVENLABS_ALLOW_FULL_TTS !== '1') {
    const err = new Error('full-clip synthesis disabled by cost policy — audio is served as sentence clips')
    err.status = 409
    throw err
  }
  return once('tts:' + abs, async () => {
    const tr = await getOrCreate(tafsir, s, a, lang)
    const text = (tr?.text || '').trim()
    if (!text) throw new Error('no transcript text to synthesize')
    const { mp3, words, dur, gen } = await ttsSynthesizeTimed(text, lang)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp-${process.pid}`
    await fs.writeFile(tmp, mp3); await fs.rename(tmp, abs) // atomic
    // Word-timing sidecar for live karaoke highlight (same path, .words.json).
    await fs.writeFile(abs.replace(/\.mp3$/, '.words.json'), JSON.stringify({ words, dur, text })).catch(() => {})
    // v2 provenance sidecar (raw alignments + request ids + credits).
    await fs.writeFile(abs.replace(/\.mp3$/, '.gen.json'), JSON.stringify({ ...gen, kind: 'tafsir', tafsir: tafsir.id, surah: s, ayah: a })).catch(() => {})
    await recordClip({ kind: 'tafsir', id: tafsir.id, lang, s, a, provider: 'elevenlabs-tts', model: EL_TTS_MODEL, sourceText: text, extra: { credits: gen?.credits }, sidecars: { 'words.json': JSON.stringify({ words, dur, text }), 'gen.json': JSON.stringify(gen) } })
    return { url: rel, cached: false }
  })
}

// ---- Exact-meaning audio: full-ayah TTS of the clean per-ayah translation ----
// Distinct from the long Bazargan tafsir lecture. Text source: the surah data
// file data/surah/<n>.json (ayahs[].{ar,fa,en,t{…}}) — a short, faithful meaning
// of each ayah. Cached at /srv/meaning-tts/<lang>/<c3>/<c3>_<v3>.mp3, served
// statically by nginx; get-or-create so each (ayah,lang) is paid for once ever.
const MEANING_DIR = process.env.MEANING_DIR || '/srv/meaning-tts'
const MEANING_LANGS = new Set(['en', 'fa', 'ar', 'tr', 'fr', 'es', 'de', 'ru'])
// Translators insert clarifying words in [..]/(..). Two spoken variants keyed by `ann`:
//   ann=true  -> keep the inserted WORDS but NEVER voice the bracket characters themselves
//   ann=false -> drop the inserted words entirely (spoken text = literal only)
const stripAnnChars = (t) => String(t || '').replace(/[[\]()﴾﴿]/g, ' ').replace(/\s+/g, ' ').trim()
const removeAnn = (t) => String(t || '').replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\s+([،.!؟:;.])/g, '$1').replace(/\s+/g, ' ').trim()
const meaningPath = (lang, s, a, ann) => path.join(MEANING_DIR, lang, pad3(s), `${pad3(s)}_${pad3(a)}${ann ? '' : '.noann'}.mp3`)
async function meaningText(s, a, lang) {
  const raw = await fs.readFile(path.join(WEBROOT, 'data', 'surah', `${s}.json`), 'utf8')
  const surah = JSON.parse(raw)
  const ayah = (surah.ayahs || []).find((x) => Number(x.n) === a)
  if (!ayah) return ''
  const t = lang === 'fa' ? ayah.fa : lang === 'en' ? ayah.en : ayah.t?.[lang]
  return String(t || '').trim()
}
async function getOrCreateMeaningTts(s, a, lang, ann) {
  const abs = meaningPath(lang, s, a, ann)
  const rel = `/meaning-tts/${lang}/${pad3(s)}/${pad3(s)}_${pad3(a)}${ann ? '' : '.noann'}.mp3`
  if (await clipReady(abs)) return { url: rel, cached: true }
  return once('meaning:' + abs, async () => {
    const raw = await meaningText(s, a, lang)
    if (!raw) { const err = new Error(`no meaning text for ${s}:${a}/${lang}`); err.statusCode = 400; throw err }
    const text = ann ? stripAnnChars(raw) : removeAnn(raw)
    if (!text) { const err = new Error(`empty meaning after annotation strip for ${s}:${a}/${lang}`); err.statusCode = 400; throw err }
    // The dedicated meaning key applies ONLY to the extra-approved surahs
    // (owner: "use this api key for only meaning for second surah") — Fatiha
    // and any SCOPE_ALL work stay on the main key.
    const key = MEANING_SURAHS_EXTRA.has(s) && EL_KEY_MEANING ? EL_KEY_MEANING : EL_KEY
    const { mp3, words, dur, gen } = await ttsSynthesizeTimed(text, lang, key)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp-${process.pid}`
    await fs.writeFile(tmp, mp3); await fs.rename(tmp, abs) // atomic
    // Word-timing sidecar for live karaoke highlight (same path, .words.json).
    await fs.writeFile(abs.replace(/\.mp3$/, '.words.json'), JSON.stringify({ words, dur, text })).catch(() => {})
    // v2 provenance sidecar (raw alignments + request ids + credits).
    await fs.writeFile(abs.replace(/\.mp3$/, '.gen.json'), JSON.stringify({ ...gen, kind: 'meaning', surah: s, ayah: a, ann: !!ann, sourceText: raw })).catch(() => {})
    await recordClip({ kind: 'meaning', lang, s, a, ann, provider: 'elevenlabs-tts', model: EL_TTS_MODEL, sourceText: text, extra: { credits: gen?.credits }, sidecars: { 'words.json': JSON.stringify({ words, dur, text }), 'gen.json': JSON.stringify(gen) } })
    return { url: rel, cached: false }
  })
}

// ---- Community comments: anyone can comment on a surah (ayah=0) or an ayah ----
// Append-only NDJSON per (surah, ayah). O_APPEND small writes are atomic on POSIX,
// so concurrent posts never clobber each other (no read-modify-write race).
const commentsFile = (s, a) => path.join(COMMENTS_DIR, pad3(s), `${pad3(a)}.ndjson`)
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max)

async function readComments(s, a) {
  try {
    const raw = await fs.readFile(commentsFile(s, a), 'utf8')
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
async function appendComment(s, a, obj) {
  const p = commentsFile(s, a)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.appendFile(p, JSON.stringify(obj) + '\n')
}
// Counts per ayah for a surah (0 = surah-level). Reads only files that exist.
async function commentCounts(s) {
  const out = {}
  try {
    for (const f of await fs.readdir(path.join(COMMENTS_DIR, pad3(s)))) {
      if (!f.endsWith('.ndjson')) continue
      const a = Number(f.slice(0, 3))
      const raw = await fs.readFile(path.join(COMMENTS_DIR, pad3(s), f), 'utf8')
      const n = raw.split('\n').filter(Boolean).length
      if (n) out[a] = n
    }
  } catch { /* none yet */ }
  return out
}

// Lightweight per-IP rate limit for posting (in-memory; resets on restart).
const postHits = new Map() // ip -> [timestamps]
function rateOk(ip) {
  const now = Date.now(), win = 60_000, max = 8
  const arr = (postHits.get(ip) || []).filter((t) => now - t < win)
  if (arr.length >= max) { postHits.set(ip, arr); return false }
  arr.push(now); postHits.set(ip, arr); return true
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'

// ---- Rich-media contributions (comment attachments) -> knowledge-graph corpus ----
// Any comment may carry image / audio / video / file attachments. Each upload is
// streamed to /srv/contributions/<c3>/<a3>/<id>.<ext>; a KG corpus record (tagged
// by ayah, author, media type) is written so every user contribution can feed a
// future QuranGPT. Voice/video are queued for transcription. Nothing is deleted.
const CONTRIB_DIR = process.env.CONTRIB_DIR || '/srv/contributions'
const CONTRIB_MAX = Number(process.env.CONTRIB_MAX_BYTES || 25_000_000) // 25 MB / file
const MIME_KIND = [
  [/^image\/(jpeg|png|webp|gif)$/, 'image'],
  [/^audio\/(mpeg|mp4|aac|ogg|webm|wav|x-m4a|m4a)$/, 'audio'],
  [/^video\/(mp4|webm|quicktime|ogg)$/, 'video'],
  [/^application\/pdf$/, 'file'],
]
const EXT_FOR = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'weba', 'audio/wav': 'wav',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv', 'application/pdf': 'pdf' }
const MIME_FOR = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', weba: 'audio/webm', wav: 'audio/wav',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', pdf: 'application/pdf' }
const kindForMime = (m) => { for (const [re, k] of MIME_KIND) if (re.test(m)) return k; return null }
const contribId = () => crypto.randomBytes(9).toString('base64url')
// The ref shape the upload endpoint returns and comments must reference.
const CONTRIB_RE = /^\/api\/contrib\/(\d{3})\/(\d{3})\/([A-Za-z0-9_-]{6,40})\.([a-z0-9]{2,4})$/

// Stream the raw request body to `dest`, capping bytes; no in-memory buffering.
function streamToFile(req, dest, maxBytes) {
  return new Promise((resolve, reject) => {
    fs.mkdir(path.dirname(dest), { recursive: true }).then(() => {
      const tmp = dest + '.part'
      const ws = createWriteStream(tmp)
      let n = 0, bad = null
      req.on('data', (c) => { n += c.length; if (n > maxBytes && !bad) { bad = new Error('too large'); req.destroy(); ws.destroy() } })
      req.on('error', (e) => { bad = bad || e })
      ws.on('error', (e) => { bad = bad || e })
      ws.on('close', () => {
        if (bad) { fs.unlink(tmp).catch(() => {}); return reject(bad) }
        fs.rename(tmp, dest).then(() => resolve(n)).catch(reject)
      })
      req.pipe(ws)
    }).catch(reject)
  })
}

// One KG corpus record per media item (transcript filled later by the pipeline).
async function kgRecord(rec) {
  const dir = path.join(CONTRIB_DIR, '_corpus', pad3(rec.surah))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, rec.id + '.json'), JSON.stringify(rec))
  if (rec.type === 'audio' || rec.type === 'video') {
    const q = path.join(CONTRIB_DIR, '_transcribe'); await fs.mkdir(q, { recursive: true })
    await fs.writeFile(path.join(q, rec.id + '.job'), JSON.stringify({ id: rec.id, surah: rec.surah, ayah: rec.ayah, file: rec.file, type: rec.type }))
  }
}

// ---- User activity log: raw events in, derived reports out ----
// POST /api/activity  { did, userId?, shellName?, events:[{v,type,ts,tzo,...}] }
//   Append-only NDJSON, sharded per device per month: /srv/activity/YYYY-MM/<did>.ndjson
//   PRINCIPLE: store raw events, derive reports later — new reports never need
//   new ingestion. Payloads are size- and shape-capped; a bad batch is dropped,
//   never 500s the reader.
// GET /api/activity/summary?did=…[&surah=N]
//   Device-scoped aggregates for the Profile insights UI: totals, per-surah
//   coverage, per-ayah listen counts (for one surah), hour-of-day histogram.
const ACTIVITY_DIR = process.env.ACTIVITY_DIR || '/srv/activity'
const ACTIVITY_EVENT_TYPES = new Set(['listen', 'read'])
const activityDidRe = /^[A-Za-z0-9-]{6,64}$/

function sanitizeActivityEvent(e) {
  if (!e || typeof e !== 'object') return null
  if (!ACTIVITY_EVENT_TYPES.has(e.type)) return null
  const ts = typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts)) ? e.ts : null
  if (!ts) return null
  const surah = Number(e.surah)
  if (!validSurah(surah)) return null
  const out = { v: 1, type: e.type, ts, tzo: Number.isInteger(e.tzo) && Math.abs(e.tzo) <= 900 ? e.tzo : 0, surah }
  if (e.type === 'listen') {
    const ayah = Number(e.ayah)
    if (!validAyah(ayah)) return null
    out.ayah = ayah
    out.kind = ['recite', 'meaning', 'tafsir'].includes(e.kind) ? e.kind : 'meaning'
    out.lang = typeof e.lang === 'string' && cleanLang(e.lang) ? e.lang : 'fa'
    if (e.mode === 'short' || e.mode === 'long') out.mode = e.mode
    if (typeof e.reciter === 'string' && /^[a-z0-9_]{2,40}$/.test(e.reciter)) out.reciter = e.reciter
    out.secs = Math.max(0, Math.min(7200, Number(e.secs) || 0))
    out.dur = Math.max(0, Math.min(7200, Number(e.dur) || 0))
    out.done = !!e.done
    out.speed = Math.max(0.25, Math.min(4, Number(e.speed) || 1))
  } else {
    out.secs = Math.max(0, Math.min(86400, Number(e.secs) || 0))
  }
  return out
}

async function appendActivity(did, meta, events) {
  const month = new Date().toISOString().slice(0, 7)
  const dir = path.join(ACTIVITY_DIR, month)
  await fs.mkdir(dir, { recursive: true })
  const lines = events.map((e) => JSON.stringify({ ...e, ...meta })).join('\n') + '\n'
  await fs.appendFile(path.join(dir, `${did}.ndjson`), lines)
}

async function readActivity(did) {
  const out = []
  let months = []
  try { months = await fs.readdir(ACTIVITY_DIR) } catch { return out }
  for (const m of months.sort()) {
    try {
      const raw = await fs.readFile(path.join(ACTIVITY_DIR, m, `${did}.ndjson`), 'utf8')
      for (const line of raw.split('\n')) {
        if (!line) continue
        try { out.push(JSON.parse(line)) } catch { /* skip bad line */ }
      }
    } catch { /* device has no events this month */ }
  }
  return out
}

// Member-scoped read: merge THIS device's events with every event any device
// tagged with the same shell member id — so insights follow the member across
// phone/desktop/embed. Scans all shards; fine at current scale (small NDJSON
// files), and a per-member index can drop in behind this signature later.
async function readActivityForMember(did, shellId) {
  const own = await readActivity(did)
  const out = own.slice()
  let months = []
  try { months = await fs.readdir(ACTIVITY_DIR) } catch { return out }
  for (const m of months.sort()) {
    let files = []
    try { files = await fs.readdir(path.join(ACTIVITY_DIR, m)) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.ndjson') || f === `${did}.ndjson`) continue
      try {
        const raw = await fs.readFile(path.join(ACTIVITY_DIR, m, f), 'utf8')
        for (const line of raw.split('\n')) {
          if (!line || !line.includes(shellId)) continue
          try {
            const e = JSON.parse(line)
            if (e.shellId === shellId) out.push(e)
          } catch { /* skip */ }
        }
      } catch { /* unreadable shard */ }
    }
  }
  return out
}

function summarizeActivity(events, surahFilter) {
  const totals = { listenSecs: 0, readSecs: 0, listens: 0, ayahsHeard: 0, surahsTouched: 0 }
  const perSurah = {}
  const perAyah = {}
  const hours = new Array(24).fill(0) // LOCAL hour (ts + tzo), seconds listened
  const heard = new Set()
  for (const e of events) {
    if (e.type === 'listen') {
      totals.listenSecs += e.secs || 0
      totals.listens += 1
      const s = (perSurah[e.surah] ||= { listens: 0, secs: 0, ayahs: new Set() })
      s.listens += 1; s.secs += e.secs || 0; s.ayahs.add(e.ayah)
      heard.add(`${e.surah}:${e.ayah}`)
      const local = new Date(Date.parse(e.ts) + (e.tzo || 0) * 60_000)
      hours[local.getUTCHours()] += e.secs || 0
      if (surahFilter && e.surah === surahFilter) {
        const a = (perAyah[e.ayah] ||= { listens: 0, secs: 0, done: 0, kinds: {} })
        a.listens += 1; a.secs += e.secs || 0; if (e.done) a.done += 1
        a.kinds[e.kind] = (a.kinds[e.kind] || 0) + 1
      }
    } else if (e.type === 'read') {
      totals.readSecs += e.secs || 0
      const s = (perSurah[e.surah] ||= { listens: 0, secs: 0, ayahs: new Set() })
      s.readSecs = (s.readSecs || 0) + (e.secs || 0)
    }
  }
  totals.ayahsHeard = heard.size
  totals.surahsTouched = Object.keys(perSurah).length
  const perSurahOut = {}
  for (const [k, v] of Object.entries(perSurah)) {
    perSurahOut[k] = { listens: v.listens, secs: Math.round(v.secs), readSecs: Math.round(v.readSecs || 0), ayahsHeard: v.ayahs.size }
  }
  return {
    totals: { ...totals, listenSecs: Math.round(totals.listenSecs), readSecs: Math.round(totals.readSecs) },
    perSurah: perSurahOut,
    ...(surahFilter ? { surah: surahFilter, perAyah } : {}),
    hourHistogram: hours.map((s) => Math.round(s)),
  }
}

// ---- Whole-surah export: ONE ZIP with everything the server holds for a surah ----
// GET /api/export?surah=N            -> streamed application/zip
// GET /api/export?surah=N&list=1     -> { files, bytes } (size preview, no data read)
// Contents: AI TTS audio + .words.json karaoke timings for every language on disk
// (meaning, long + short tafsir), all transcripts (STT + translations), the human
// SOURCE recordings (STT sources — the app itself never plays them), the app
// recitation files if present, and the surah text JSON. STORE-method ZIP written
// by hand (mp3s are already compressed), streamed file-by-file with backpressure
// so memory stays at one-file peak. NOTE: plain ZIP32 — fine for per-surah
// exports; a whole-corpus multi-GB export would need ZIP64 (not needed yet).
const _zipCrcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
const zipCrc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = _zipCrcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const le16 = (v) => Buffer.from([v & 255, (v >> 8) & 255])
const le32 = (v) => Buffer.from([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255])

// Everything on disk for surah `s`, as {abs, name} zip entries. Read-only walk of
// FIXED roots + the surah's zero-padded directory — no user input ever joins a path.
async function listSurahExport(s) {
  const c3 = pad3(s)
  const out = []
  const addDir = async (absDir, zipPrefix) => {
    let entries = []
    try { entries = await fs.readdir(absDir) } catch { return }
    for (const e of entries.sort()) {
      if (e.startsWith('.') || e.includes('.tmp-') || e.includes('.bak')) continue
      out.push({ abs: path.join(absDir, e), name: `${zipPrefix}/${e}` })
    }
  }
  await addDir(path.join(SRV, 'tafsir', 'ssn', c3), 'source-recordings/long')
  await addDir(path.join(SRV, 'tafsir-short', c3), 'source-recordings/short')
  await addDir(path.join(SRV, 'recitation', c3), 'recitation')
  for (const id of ['bazargan', 'bazargan-short']) {
    let langs = []
    try { langs = await fs.readdir(path.join(TTS_DIR, id)) } catch { /* none yet */ }
    for (const l of langs.sort()) await addDir(path.join(TTS_DIR, id, l, c3), `tafsir-ai/${id}/${l}`)
  }
  {
    let langs = []
    try { langs = await fs.readdir(MEANING_DIR) } catch { /* none yet */ }
    for (const l of langs.sort()) await addDir(path.join(MEANING_DIR, l, c3), `meaning-ai/${l}`)
  }
  for (const id of ['bazargan', 'bazargan-short']) {
    let langs = []
    try { langs = await fs.readdir(path.join(TRANSCRIPTS, id)) } catch { /* none yet */ }
    for (const l of langs.sort()) await addDir(path.join(TRANSCRIPTS, id, l, c3), `transcripts/${id}/${l}`)
  }
  out.push({ abs: path.join(WEBROOT, 'data', 'surah', `${s}.json`), name: `text/surah-${s}.json` })
  return out
}

async function streamSurahZip(res, s) {
  const files = await listSurahExport(s)
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="QuranHakim-surah${pad3(s)}-all.zip"`,
    'cache-control': 'no-store',
  })
  const write = (buf) => new Promise((resolve) => (res.write(buf) ? resolve() : res.once('drain', resolve)))
  const central = []
  let offset = 0
  let count = 0
  for (const f of files) {
    let data
    try { data = await fs.readFile(f.abs) } catch { continue } // listed but unreadable -> skip
    const name = Buffer.from(f.name, 'utf8')
    const crc = zipCrc32(data)
    const head = Buffer.concat([
      le32(0x04034b50), le16(20), le16(0x0800), le16(0), le16(0), le16(0),
      le32(crc), le32(data.length), le32(data.length), le16(name.length), le16(0),
    ])
    await write(head); await write(name); await write(data)
    central.push(Buffer.concat([
      le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(0), le16(0), le16(0),
      le32(crc), le32(data.length), le32(data.length), le16(name.length), le16(0),
      le16(0), le16(0), le16(0), le32(0), le32(offset), name,
    ]))
    offset += head.length + name.length + data.length
    count++
  }
  let cdSize = 0
  for (const c of central) { await write(c); cdSize += c.length }
  await write(Buffer.concat([
    le32(0x06054b50), le16(0), le16(0), le16(count), le16(count),
    le32(cdSize), le32(offset), le16(0),
  ]))
  res.end()
}

// ---- Manifest of generated assets (transcripts + TTS audio) for "download all" ----
// Walks the cache trees and returns static URL paths; cached 60s. Read-only.
let _manifest = null
async function walkFiles(root, urlPrefix) {
  const out = []
  async function rec(dir, rel) {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.includes('.tmp-')) continue
      const p = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await rec(p, r)
      else out.push(`${urlPrefix}/${r}`)
    }
  }
  await rec(root, '')
  return out
}
async function getManifest() {
  if (_manifest && Date.now() - _manifest.at < 60_000) return _manifest.data
  const [transcripts, tts, meaning] = await Promise.all([
    walkFiles(TRANSCRIPTS, '/transcripts'),
    walkFiles(TTS_DIR, '/tafsir-tts'),
    walkFiles(MEANING_DIR, '/meaning-tts'),
  ])
  _manifest = { at: Date.now(), data: { transcripts, tts, meaning } }
  return _manifest.data
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c) => { b += c; if (b.length > 5_000_000) req.destroy() })
    req.on('end', () => resolve(b))
    req.on('error', reject)
  })
}

// ==================== AUTH: transport gating (verdict #24-26) ====================
// nginx sets X-Forwarded-Proto ($scheme); node also binds behind it. Refuse to
// issue/accept sessions over insecure transport.
const isSecureReq = (req) =>
  req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted

// ==================== AUTH: JWKS verification (node:crypto, zero deps) ====================
const b64urlToBuf = (s) => Buffer.from(String(s), 'base64url')
const b64urlJson = (s) => JSON.parse(b64urlToBuf(s).toString('utf8'))
// Client hashes a raw nonce with SHA-256 before handing it to Apple/Google; the
// server re-derives the same digest from the raw nonce it receives (verdict #6).
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

// Generic JWKS cache keyed by URL. Honors Cache-Control: max-age; falls back to 1h.
const _jwks = new Map() // url -> { keys: Map<kid, KeyObject>, exp: number }
async function getJwksKey(url, kid) {
  const now = Date.now()
  let entry = _jwks.get(url)
  if (!entry || now >= entry.exp || !entry.keys.has(kid)) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`JWKS ${res.status}`)
    const { keys } = await res.json()
    const map = new Map()
    for (const jwk of keys) map.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }))
    const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '')
    entry = { keys: map, exp: now + (m ? Number(m[1]) * 1000 : 3600_000) }
    _jwks.set(url, entry)
  }
  const key = entry.keys.get(kid)
  if (!key) throw new Error('signing key not found (rotated?)')
  return key
}

// Verify an RS256 JWT against a JWKS. Enforces alg allowlist + iss + aud + exp/iat. Returns claims.
async function verifyRs256(idToken, { jwksUrl, allowedIss, allowedAud }) {
  const parts = String(idToken).split('.')
  if (parts.length !== 3) throw new Error('malformed JWT')
  const [h, p, sig] = parts
  const header = b64urlJson(h)
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`) // reject none/alg-confusion
  const key = await getJwksKey(jwksUrl, header.kid)
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, b64urlToBuf(sig))
  if (!ok) throw new Error('bad signature')
  const c = b64urlJson(p)
  const now = Math.floor(Date.now() / 1000), skew = 60
  if (!allowedIss.has(c.iss)) throw new Error(`bad iss ${c.iss}`)
  if (!allowedAud.has(c.aud)) throw new Error(`bad aud ${c.aud}`)
  if (typeof c.exp !== 'number' || c.exp + skew < now) throw new Error('expired')
  if (typeof c.iat === 'number' && c.iat - skew > now) throw new Error('iat in future')
  return c
}

const APPLE_ISS = new Set(['https://appleid.apple.com'])
const GOOGLE_ISS = new Set(['https://accounts.google.com', 'accounts.google.com'])

// Nonce binding (verdict #6): the token's nonce claim MUST equal sha256hex(rawNonce).
// The client passes sha256(rawNonce) to the provider and the raw nonce to us; a
// captured ID token can't be replayed without the (never-transmitted-in-token) preimage.
function assertNonce(claim, rawNonce) {
  if (!rawNonce) throw new Error('missing nonce')
  if (typeof claim !== 'string' || claim.length === 0) throw new Error('token missing nonce')
  const a = Buffer.from(claim)
  const b = Buffer.from(sha256hex(rawNonce))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('nonce mismatch')
}

// Returns normalized claims { sub, email?, emailVerified, isPrivateEmail } or throws.
async function verifyAppleToken(idToken, { rawNonce } = {}) {
  const c = await verifyRs256(idToken, {
    jwksUrl: 'https://appleid.apple.com/auth/keys', allowedIss: APPLE_ISS, allowedAud: APPLE_AUDS,
  })
  assertNonce(c.nonce, rawNonce)
  return {
    sub: c.sub,
    email: c.email ?? null,
    emailVerified: c.email_verified === true || c.email_verified === 'true',
    isPrivateEmail: c.is_private_email === true || c.is_private_email === 'true',
    // Apple never puts name in the token; the client forwards it on first login (see route).
  }
}
async function verifyGoogleToken(idToken, { rawNonce } = {}) {
  const c = await verifyRs256(idToken, {
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', allowedIss: GOOGLE_ISS, allowedAud: GOOGLE_AUDS,
  })
  assertNonce(c.nonce, rawNonce)
  return {
    sub: c.sub,
    email: c.email ?? null,
    emailVerified: c.email_verified === true || c.email_verified === 'true',
    name: c.name ?? null,
    picture: c.picture ?? null,
  }
}

// ==================== USER STORE: /srv/users/<provider>/<sub>.json ====================
const PROVIDERS = new Set(['apple', 'google'])
const safeSub = (sub) => String(sub).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)
const userPath = (provider, sub) => path.join(USERS_DIR, provider, `${safeSub(sub)}.json`)

async function readUser(provider, sub) {
  try { return JSON.parse(await fs.readFile(userPath(provider, sub), 'utf8')) } catch { return null }
}
async function readUserById(id) { // id = "<provider>:<sub>"
  const i = String(id).indexOf(':')
  if (i < 0) return null
  return readUser(id.slice(0, i), id.slice(i + 1))
}
// Atomic publish: tmp + rename (same idiom as getOrCreateTts).
async function writeJsonAtomic(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  await fs.writeFile(tmp, JSON.stringify(obj))
  await fs.rename(tmp, p)
}
// Get-or-create on login. claims = { sub, name?, email?, picture?, isPrivateEmail? } from a VERIFIED token.
// PII minimization (verdict #32/#35): email only stored when caller passes it (already gated on
// emailVerified in the routes); Apple relay addresses are marked via isPrivateEmail.
// Existing users keep id + createdAt; only mutable profile fields refresh.
async function getOrCreateUser(provider, claims) {
  if (!PROVIDERS.has(provider)) throw new Error('bad provider')
  const sub = String(claims.sub || '').trim()
  if (!sub) throw new Error('missing sub')
  const existing = await readUser(provider, sub)
  const id = existing?.id || `${provider}:${sub}`
  const name = clean(claims.name, 80) || existing?.name || 'User'
  const email = claims.email ? clean(claims.email, 254) : (existing?.email || undefined)
  const picture = claims.picture ? clean(claims.picture, 500) : (existing?.picture || undefined)
  const isPrivateEmail = claims.isPrivateEmail != null ? !!claims.isPrivateEmail : existing?.isPrivateEmail
  const user = {
    id, provider, sub, name,
    ...(email ? { email } : {}),
    ...(picture ? { picture } : {}),
    ...(isPrivateEmail != null ? { isPrivateEmail } : {}),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await writeJsonAtomic(userPath(provider, sub), user)
  return user
}
// Public projection handed to the client (never leak internals).
const publicUser = (u) => ({
  id: u.id, provider: u.provider, name: u.name,
  ...(u.email ? { email: u.email } : {}),
  ...(u.picture ? { picture: u.picture } : {}),
  createdAt: u.createdAt,
})

// ==================== SESSIONS: stateless HS256 JWT ====================
const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlJsonEnc = (obj) => b64url(JSON.stringify(obj))
const hmac = (data) => b64url(crypto.createHmac('sha256', SESSION_SECRET).update(data).digest())

function signSession(user) {
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET not configured')
  const now = Math.floor(Date.now() / 1000)
  const header = b64urlJsonEnc({ alg: 'HS256', typ: 'JWT' })
  const payload = b64urlJsonEnc({
    sub: user.id, name: user.name, provider: user.provider, iat: now, exp: now + SESSION_TTL_S,
  })
  const body = `${header}.${payload}`
  return `${body}.${hmac(body)}`
}
function verifySession(token) {
  // Size cap BEFORE any crypto (verdict #17): reject oversized/garbage tokens cheaply.
  if (!SESSION_SECRET || typeof token !== 'string' || token.length > SESSION_TOKEN_MAX) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, p, sig] = parts
  let header
  try { header = b64urlJson(h) } catch { return null }
  if (!header || header.alg !== 'HS256') return null // pin alg — reject none/RS256 alg-confusion
  const expected = hmac(`${h}.${p}`)
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let payload
  try { payload = JSON.parse(b64urlToBuf(p).toString('utf8')) } catch { return null }
  if (!payload || typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return null
  const now = Math.floor(Date.now() / 1000)
  if (payload.iat - 60 > now) return null   // issued in the future -> forged
  if (now >= payload.exp) return null        // hard expiry
  return payload
}
const bearer = (req) => {
  const h = req.headers['authorization'] || ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

// Per-IP auth rate limit (separate bucket from comments; in-memory, resets on restart).
const authHits = new Map()
function authRateOk(ip) {
  const now = Date.now(), win = 60_000, max = 20
  const arr = (authHits.get(ip) || []).filter((t) => now - t < win)
  if (arr.length >= max) { authHits.set(ip, arr); return false }
  arr.push(now); authHits.set(ip, arr); return true
}

// requireUser(req) -> on-disk user record | null (reflects deleted/renamed users).
// Refuses insecure transport (verdict #24-26) and burns per-IP budget on each failed
// session verification so invalid-token fuzzing is costed on protected routes (verdict #31).
async function requireUser(req) {
  if (!isSecureReq(req)) return null
  const tok = bearer(req)
  if (!tok) return null
  const payload = verifySession(tok)
  if (!payload) { authRateOk(clientIp(req)); return null }
  const u = await readUserById(payload.sub)
  if (!u) { authRateOk(clientIp(req)); return null }
  return u
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')

  // ---- CORS (header-token model; echo only allowlisted origins, no credentials) ----
  const origin = req.headers['origin']
  if (origin === WEB_ORIGIN || origin === NATIVE_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age', '600')
    // Note: NO Access-Control-Allow-Credentials — we use Bearer headers, not cookies.
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  // Container liveness probe (the JooW apphost mount's healthPath is /health).
  // Deliberately dependency-free: 200 as soon as the process is serving.
  if (url.pathname === '/health') return json(res, 200, { ok: true })
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, stt: !!EL_KEY, translator: !!ANTHROPIC_KEY, model: EL_MODEL, tts: !!(EL_KEY && EL_VOICE), ttsModel: EL_TTS_MODEL, auth: !!SESSION_SECRET, apple: APPLE_AUDS.size > 0, google: GOOGLE_AUDS.size > 0 })
  if (url.pathname === '/api/transcript') {
    // POST = a device (e.g. iOS on-device speech) CONTRIBUTES a transcript to the shared cache.
    if (req.method === 'POST') {
      try {
        const d = JSON.parse((await readBody(req)) || '{}')
        const s = Number(d.surah), a = Number(d.ayah)
        const tafsirs = await loadTafsirs()
        const tafsir = tafsirs.find((t) => t.id === d.tafsir)
        if (!tafsir || !validSurah(s) || !validAyah(a)) return json(res, 400, { error: 'bad params' })
        const lang = cleanLang(d.lang || tafsir.transcript?.lang || tafsir.language)
        if (!lang) return json(res, 400, { error: 'bad lang' })
        const p = cachePath(tafsir.id, lang, s, a)
        // replace:true may overwrite — curated uploads only, and ONLY with the
        // shared secret (an unauthenticated overwrite was a content-wipe hole).
        const mayReplace = d.replace === true && d.source === 'claude-translation'
          && CONTRIBUTE_SECRET && req.headers['x-contribute-secret'] === CONTRIBUTE_SECRET
        if (!mayReplace && (await readCache(p))) return json(res, 200, { saved: false, existed: true })
        const text = String(d.text || '').trim()
        if (text.length < 5) return json(res, 400, { error: 'empty text' })
        // Optional sentence-timing segments aligned to the ORIGINAL (source-language)
        // audio — lets translated transcripts highlight in sync with the recording.
        let segments
        if (Array.isArray(d.segments)) {
          segments = d.segments.slice(0, 2000)
            .map((x) => ({ s: Math.round((+x.s || 0) * 100) / 100, e: Math.round((+x.e || 0) * 100) / 100, text: String(x.text || '').trim().slice(0, 4000) }))
            .filter((x) => x.text && x.e > x.s)
          if (!segments.length) segments = undefined
        }
        await writeCache(p, { text, lang, source: d.source || 'device-ios', createdAt: new Date().toISOString(), ...(segments ? { segments } : {}) })
        return json(res, 200, { saved: true, existed: false, segments: segments ? segments.length : 0 })
      } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
    }
    // GET = get-or-create (ElevenLabs Scribe fallback if not yet contributed).
    try {
      if (!EL_KEY) return json(res, 503, { error: 'transcription not configured: set ELEVENLABS_API_KEY' })
      const id = url.searchParams.get('tafsir')
      const s = Number(url.searchParams.get('surah'))
      const a = Number(url.searchParams.get('ayah'))
      const tafsirs = await loadTafsirs()
      const tafsir = tafsirs.find((t) => t.id === id)
      if (!tafsir || !validSurah(s) || !validAyah(a)) return json(res, 400, { error: 'bad params' })
      const lang = cleanLang(url.searchParams.get('lang') || tafsir.transcript?.lang || tafsir.language)
      if (!lang) return json(res, 400, { error: 'bad lang' })
      if (!SCOPE_ALL && s !== 1) {
        // Outside the pilot scope: serve the cache, never generate (cost gate).
        const hit = await readCache(cachePath(tafsir.id, lang, s, a))
        if (hit) return json(res, 200, hit)
        return json(res, 503, { error: 'study content for this surah is coming soon' })
      }
      return json(res, 200, await getOrCreate(tafsir, s, a, lang))
    } catch (e) { console.error('[transcript]', e?.message || e); return json(res, 503, { error: 'transcription is temporarily unavailable' }) }
  }
  if (url.pathname === '/api/tts-audio') {
    try {
      if (!EL_KEY || !EL_VOICE) return json(res, 503, { error: 'tts not configured: set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID' })
      const id = url.searchParams.get('tafsir')
      const s = Number(url.searchParams.get('surah'))
      const a = Number(url.searchParams.get('ayah'))
      const tafsirs = await loadTafsirs()
      const tafsir = tafsirs.find((t) => t.id === id)
      if (!tafsir || !validSurah(s) || !validAyah(a)) return json(res, 400, { error: 'bad params' })
      const lang = cleanLang(url.searchParams.get('lang') || tafsir.transcript?.lang || tafsir.language)
      if (!lang) return json(res, 400, { error: 'bad lang' })
      if (!SCOPE_ALL && s !== 1 && !(await fileExists(ttsPath(tafsir.id, lang, s, a)))) {
        return json(res, 503, { error: 'spoken audio for this surah is coming soon' })
      }
      return json(res, 200, { ok: true, ...(await getOrCreateTts(tafsir, s, a, lang)), model: EL_TTS_MODEL })
    } catch (e) { console.error('[tts-audio]', e?.message || e); const code = e?.statusCode === 503 ? 503 : e?.statusCode === 409 || e?.status === 409 ? 409 : 502; return json(res, code, { error: code === 503 ? 'not_ready' : 'audio generation is temporarily unavailable' }) }
  }
  // ---- GET /api/meaning-audio?surah=&ayah=&lang= -> { ok, url, cached } ----
  // Full-ayah spoken "exact meaning" (clean translation). Gated to Fatiha until
  // ALLOW_ALL_SURAHS=1; 503 {error:'not_ready'} when a clip isn't generated yet.
  if (url.pathname === '/api/meaning-audio') {
    try {
      if (!EL_KEY || !EL_VOICE) return json(res, 503, { error: 'tts not configured: set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID' })
      const s = Number(url.searchParams.get('surah'))
      const a = Number(url.searchParams.get('ayah'))
      const lang = cleanLang(url.searchParams.get('lang'))
      const ann = url.searchParams.get('ann') !== '0' // default: voice the inserted words (brackets stripped)
      if (!validSurah(s) || !validAyah(a) || !lang || !MEANING_LANGS.has(lang)) return json(res, 400, { error: 'bad params' })
      if (!SCOPE_ALL && s !== 1 && !MEANING_SURAHS_EXTRA.has(s) && !(await fileExists(meaningPath(lang, s, a, ann)))) {
        return json(res, 503, { error: 'not_ready' })
      }
      return json(res, 200, { ok: true, ...(await getOrCreateMeaningTts(s, a, lang, ann)), model: EL_TTS_MODEL })
    } catch (e) { console.error('[meaning-audio]', e?.message || e); const code = e?.statusCode === 503 ? 503 : e?.statusCode === 400 ? 400 : 502; return json(res, code, { error: code === 503 ? 'not_ready' : 'audio generation is temporarily unavailable' }) }
  }
  // ---- GET /api/tts-segment?tafsir=&surah=&ayah=&lang=&idx= -> { ok, url, cached } ----
  // Per-sentence TTS clip from the cached transcript's segments[idx].text.
  if (url.pathname === '/api/tts-segment') {
    try {
      if (!EL_KEY || !EL_VOICE) return json(res, 503, { error: 'tts not configured: set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID' })
      const id = url.searchParams.get('tafsir')
      const s = Number(url.searchParams.get('surah'))
      const a = Number(url.searchParams.get('ayah'))
      // `idx` is canonical; accept `seg` as an alias (older clients sent it). A
      // MISSING index must 400 — Number(null) is 0, which would silently serve seg 0.
      const idxRaw = url.searchParams.get('idx') ?? url.searchParams.get('seg')
      const idx = Number(idxRaw)
      const tafsirs = await loadTafsirs()
      const tafsir = tafsirs.find((t) => t.id === id)
      if (!tafsir || !validSurah(s) || !validAyah(a) || idxRaw == null || idxRaw === '' || !Number.isInteger(idx) || idx < 0 || idx > 4000) return json(res, 400, { error: 'bad params' })
      const lang = cleanLang(url.searchParams.get('lang') || tafsir.transcript?.lang || tafsir.language)
      if (!lang) return json(res, 400, { error: 'bad lang' })
      if (!SCOPE_ALL && s !== 1 && !(await fileExists(ttsSegPath(tafsir.id, lang, s, a, idx)))) {
        return json(res, 503, { error: 'spoken audio for this surah is coming soon' })
      }
      return json(res, 200, await getOrCreateSegTts(tafsir, s, a, lang, idx))
    } catch (e) { console.error('[tts-segment]', e?.message || e); const code = e?.statusCode === 503 ? 503 : e?.statusCode === 400 ? 400 : 502; return json(res, code, { error: code === 503 ? 'not_ready' : 'audio generation is temporarily unavailable' }) }
  }
  if (url.pathname === '/api/manifest') {
    try { return json(res, 200, await getManifest()) }
    catch (e) { return json(res, 500, { error: String(e.message || e) }) }
  }
  // ---- POST /api/activity  |  GET /api/activity/summary ----
  if (url.pathname === '/api/activity' && req.method === 'POST') {
    try {
      if (!rateOk(clientIp(req))) return json(res, 429, { error: 'slow down' })
      const d = JSON.parse((await readBody(req)) || '{}')
      const did = typeof d.did === 'string' && activityDidRe.test(d.did) ? d.did : null
      if (!did || !Array.isArray(d.events)) return json(res, 400, { error: 'bad batch' })
      const events = d.events.slice(0, 100).map(sanitizeActivityEvent).filter(Boolean)
      if (events.length) {
        const meta = {}
        if (typeof d.userId === 'string' && d.userId.length <= 64) meta.userId = d.userId
        if (typeof d.shellName === 'string' && d.shellName.length <= 80) meta.shellName = d.shellName
        if (typeof d.shellId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(d.shellId)) meta.shellId = d.shellId
        await appendActivity(did, meta, events)
      }
      return json(res, 200, { ok: true, accepted: events.length })
    } catch (e) { console.error('[activity]', e?.message || e); return json(res, 200, { ok: false }) }
  }
  if (url.pathname === '/api/activity/summary') {
    try {
      const did = url.searchParams.get('did') || ''
      if (!activityDidRe.test(did)) return json(res, 400, { error: 'bad did' })
      const surah = Number(url.searchParams.get('surah')) || 0
      const member = url.searchParams.get('member') || ''
      const events = /^[A-Za-z0-9_-]{1,64}$/.test(member)
        ? await readActivityForMember(did, member)
        : await readActivity(did)
      return json(res, 200, summarizeActivity(events, validSurah(surah) ? surah : 0))
    } catch (e) { console.error('[activity-summary]', e?.message || e); return json(res, 500, { error: 'summary failed' }) }
  }
  // ---- GET /api/usage -> credits ledger summary (today / by day / totals) ----
  if (url.pathname === '/api/usage') {
    try {
      const entries = await readLedger()
      const byDay = {}
      let total = 0
      for (const e of entries) {
        const day = (e.ts || '').slice(0, 10)
        const cr = e.characterCost || e.chars || 0
        byDay[day] = (byDay[day] || 0) + cr
        total += cr
      }
      const today = new Date().toISOString().slice(0, 10)
      return json(res, 200, {
        today: { credits: byDay[today] || 0, budget: EL_DAILY_BUDGET || null },
        total: { credits: total, calls: entries.length },
        byDay,
        note: 'ledger starts 2026-07-19 (v2 capture) — earlier spend is not recorded',
      })
    } catch (e) { return json(res, 500, { error: String(e.message || e) }) }
  }
  // ---- GET /api/export?surah=N[&list=1] -> whole-surah ZIP (or size preview) ----
  if (url.pathname === '/api/export') {
    const s = Number(url.searchParams.get('surah'))
    if (!validSurah(s)) return json(res, 400, { error: 'bad surah' })
    try {
      if (url.searchParams.get('list')) {
        const files = await listSurahExport(s)
        let bytes = 0
        for (const f of files) { try { bytes += (await fs.stat(f.abs)).size } catch { /* skip */ } }
        return json(res, 200, { surah: s, files: files.length, bytes })
      }
      return await streamSurahZip(res, s)
    } catch (e) {
      console.error('[export]', e?.message || e)
      if (!res.headersSent) return json(res, 500, { error: 'export failed' })
      try { res.destroy() } catch { /* stream already broken */ }
    }
  }
  // ---- POST /api/contrib/upload : stream ONE media file, return its ref ----
  // Query: ?surah=&ayah=&name=&dur=   Body: raw bytes (Content-Type = the mime).
  if (url.pathname === '/api/contrib/upload' && req.method === 'POST') {
    try {
      if (!rateOk(clientIp(req))) return json(res, 429, { error: 'too many uploads, slow down' })
      const s = Number(url.searchParams.get('surah')), a = Number(url.searchParams.get('ayah')) || 0
      if (!(s >= 1 && s <= 114) || a < 0 || a > 300) return json(res, 400, { error: 'bad params' })
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      const kind = kindForMime(mime)
      if (!kind) return json(res, 415, { error: 'unsupported media type' })
      const ext = EXT_FOR[mime] || 'bin'
      const id = contribId()
      const rel = `/api/contrib/${pad3(s)}/${pad3(a)}/${id}.${ext}`
      const dest = path.join(CONTRIB_DIR, pad3(s), pad3(a), `${id}.${ext}`)
      let bytes
      try { bytes = await streamToFile(req, dest, CONTRIB_MAX) }
      catch (e) { return json(res, /too large/.test(String(e.message)) ? 413 : 500, { error: String(e.message || e) }) }
      const name = clean(url.searchParams.get('name'), 120) || `${kind}.${ext}`
      const dur = Number(url.searchParams.get('dur')) || undefined
      const authed = await requireUser(req)
      await fs.writeFile(dest.replace(/\.[a-z0-9]+$/, '.meta.json'), JSON.stringify({
        id, surah: s, ayah: a, type: kind, mime, name, dur, bytes,
        by: authed ? { id: authed.id, name: authed.name } : null,
        ipHash: crypto.createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 16),
        at: new Date().toISOString(),
      })).catch(() => {})
      return json(res, 200, { id, url: rel, type: kind, mime, name, ...(dur ? { dur } : {}), bytes })
    } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
  }

  // ---- GET /api/contrib/<c3>/<a3>/<file> : stream a contribution (Range-aware) ----
  if (url.pathname.startsWith('/api/contrib/') && req.method === 'GET') {
    const m = url.pathname.match(CONTRIB_RE)
    if (!m) return json(res, 404, { error: 'not found' })
    const [, c3, a3, , ext] = m
    const abs = path.join(CONTRIB_DIR, c3, a3, path.basename(url.pathname))
    if (!abs.startsWith(CONTRIB_DIR + path.sep)) return json(res, 400, { error: 'bad path' }) // traversal guard
    let st; try { st = await fs.stat(abs) } catch { return json(res, 404, { error: 'not found' }) }
    const mime = MIME_FOR[ext] || 'application/octet-stream'
    const base = { 'content-type': mime, 'cache-control': 'public, max-age=31536000, immutable', 'accept-ranges': 'bytes' }
    const range = req.headers.range
    if (range) {
      const mm = /bytes=(\d*)-(\d*)/.exec(range) || []
      let start = mm[1] ? parseInt(mm[1], 10) : 0
      let end = mm[2] ? parseInt(mm[2], 10) : st.size - 1
      if (isNaN(start) || isNaN(end) || start > end || end >= st.size) { start = 0; end = st.size - 1 }
      res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 })
      return createReadStream(abs, { start, end }).pipe(res)
    }
    res.writeHead(200, { ...base, 'content-length': st.size })
    return createReadStream(abs).pipe(res)
  }

  if (url.pathname === '/api/comments') {
    // GET ?surah=&ayah=            -> { comments: [...] }
    // GET ?surah=&counts=1         -> { counts: { <ayah>: n } }  (ayah 0 = surah-level)
    // POST { surah, ayah, name, text } -> { comment }
    try {
      if (req.method === 'GET') {
        const s = Number(url.searchParams.get('surah'))
        if (!(s >= 1 && s <= 114)) return json(res, 400, { error: 'bad surah' })
        if (url.searchParams.get('counts')) return json(res, 200, { surah: s, counts: await commentCounts(s) })
        const a = Number(url.searchParams.get('ayah')) || 0
        if (a < 0 || a > 300) return json(res, 400, { error: 'bad ayah' })
        return json(res, 200, { surah: s, ayah: a, comments: await readComments(s, a) })
      }
      if (req.method === 'POST') {
        if (!rateOk(clientIp(req))) return json(res, 429, { error: 'too many comments, slow down' })
        const d = JSON.parse((await readBody(req)) || '{}')
        const s = Number(d.surah), a = Number(d.ayah) || 0
        if (!(s >= 1 && s <= 114) || a < 0 || a > 300) return json(res, 400, { error: 'bad params' })
        const text = clean(d.text, 2000)
        // Rich-media: validate each ref is an upload the server minted for THIS ayah.
        const media = Array.isArray(d.media) ? d.media.slice(0, 6).map((mi) => {
          const u = String((mi && mi.url) || ''); const mm = u.match(CONTRIB_RE)
          if (!mm || Number(mm[1]) !== s || Number(mm[2]) !== a) return null
          return { id: clean(mi.id, 40), url: u, type: clean(mi.type, 12), mime: clean(mi.mime, 60), name: clean(mi.name, 120), ...(mi.dur ? { dur: Number(mi.dur) } : {}) }
        }).filter(Boolean) : []
        if (text.length < 1 && media.length === 0) return json(res, 400, { error: 'empty comment' })
        // Attribution: a valid Bearer token OVERRIDES any client-supplied name/verified flag.
        // requireUser refuses insecure transport and costs invalid-token fuzzing (verdict #24-26, #31).
        const authed = await requireUser(req)
        const baseC = { id: crypto.randomUUID(), text, at: new Date().toISOString(), ...(media.length ? { media } : {}) }
        const comment = authed
          ? { ...baseC, name: authed.name, userId: authed.id,
              ...(authed.picture ? { picture: authed.picture } : {}), verified: true }
          : { ...baseC, name: clean(d.name, 48) || 'Anonymous', verified: false }
        await appendComment(s, a, comment)
        // Feed the knowledge-graph corpus: one record per media item, tagged by ayah.
        for (const mi of media) {
          const mm = mi.url.match(CONTRIB_RE)
          await kgRecord({ id: mi.id || contribId(), commentId: comment.id, surah: s, ayah: a,
            type: mi.type, mime: mi.mime, url: mi.url, file: `${mm[1]}/${mm[2]}/${path.basename(mi.url)}`,
            name: mi.name, ...(mi.dur ? { dur: mi.dur } : {}), text,
            by: comment.userId ? { id: comment.userId, name: comment.name } : { name: comment.name },
            transcript: null, consent: true, at: comment.at }).catch(() => {})
        }
        return json(res, 200, { comment })
      }
      return json(res, 405, { error: 'method not allowed' })
    } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
  }
  // ---- POST /api/auth/apple  { identityToken, nonce, name? } -> { token, user } ----
  if (url.pathname === '/api/auth/apple' && req.method === 'POST') {
    try {
      if (!isSecureReq(req)) return json(res, 403, { error: 'insecure transport' }) // verdict #24-26
      if (!SESSION_SECRET) return json(res, 503, { error: 'auth not configured: set SESSION_SECRET' })
      if (!authRateOk(clientIp(req))) return json(res, 429, { error: 'too many attempts' })
      const d = JSON.parse((await readBody(req)) || '{}')
      if (!d.identityToken) return json(res, 400, { error: 'missing identityToken' })
      if (!d.nonce) return json(res, 400, { error: 'missing nonce' }) // verdict #6 — never nonce-less
      const v = await verifyAppleToken(String(d.identityToken), { rawNonce: String(d.nonce) })
      // Apple sends the human name only on the FIRST authorization -> client forwards it here.
      const claims = {
        sub: v.sub,
        email: v.emailVerified ? v.email : null, // PII: only store verified email (verdict #32)
        isPrivateEmail: v.isPrivateEmail,
        name: d.name || null,
      }
      const user = await getOrCreateUser('apple', claims)
      return json(res, 200, { token: signSession(user), user: publicUser(user) })
    } catch (e) { return json(res, 401, { error: String(e.message || e) }) }
  }

  // ---- POST /api/auth/google  { idToken, nonce } -> { token, user } ----
  if (url.pathname === '/api/auth/google' && req.method === 'POST') {
    try {
      if (!isSecureReq(req)) return json(res, 403, { error: 'insecure transport' }) // verdict #24-26
      if (!SESSION_SECRET) return json(res, 503, { error: 'auth not configured: set SESSION_SECRET' })
      if (!authRateOk(clientIp(req))) return json(res, 429, { error: 'too many attempts' })
      const d = JSON.parse((await readBody(req)) || '{}')
      if (!d.idToken) return json(res, 400, { error: 'missing idToken' })
      if (!d.nonce) return json(res, 400, { error: 'missing nonce' }) // verdict #6 — never nonce-less
      const v = await verifyGoogleToken(String(d.idToken), { rawNonce: String(d.nonce) })
      if (!v.emailVerified) return json(res, 403, { error: 'email not verified' })
      const claims = { sub: v.sub, email: v.email, name: v.name, picture: v.picture }
      const user = await getOrCreateUser('google', claims)
      return json(res, 200, { token: signSession(user), user: publicUser(user) })
    } catch (e) { return json(res, 401, { error: String(e.message || e) }) }
  }

  // ---- GET /api/auth/me  (Bearer) -> { user } | 401 ----
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    if (!isSecureReq(req)) return json(res, 403, { error: 'insecure transport' }) // verdict #24-26
    const user = await requireUser(req)
    if (!user) return json(res, 401, { error: 'not signed in' })
    return json(res, 200, { user: publicUser(user) })
  }

  json(res, 404, { error: 'not found' })
})
server.listen(PORT, '127.0.0.1', () => console.log(`joowquran-api on 127.0.0.1:${PORT} (stt=${!!EL_KEY}, translator=${!!ANTHROPIC_KEY})`))
