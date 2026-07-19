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
import path from 'node:path'
import crypto from 'node:crypto'

const PORT = Number(process.env.PORT || 8787)
const EL_KEY = process.env.ELEVENLABS_API_KEY || ''
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
        }))
    : undefined
  return { text: d.text || '', words }
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
      orig = { text: r.text, lang: origLang, source: 'elevenlabs-scribe', model: EL_MODEL, createdAt: new Date().toISOString(), ...(r.words ? { words: r.words } : {}) }
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

// Per-sentence clip path: one MP3 per transcript segment (same tree as full-ayah TTS).
const ttsSegPath = (id, lang, s, a, idx) => path.join(TTS_DIR, id, lang, pad3(s), `${pad3(s)}_${pad3(a)}.seg${idx}.mp3`)

// Get-or-create the TTS clip for ONE transcript segment (sentence). Reads the segment
// text from the cached transcript JSON (segments:[{s,e,text}]). [audio-tags] are KEPT
// by default — ElevenLabs v3 reads them for tone — and only stripped on a retry if
// the API errors on the tagged text. Cost is paid once ever (disk cache + once() dedup).
async function getOrCreateSegTts(tafsir, s, a, lang, idx) {
  const abs = ttsSegPath(tafsir.id, lang, s, a, idx)
  const rel = `/tafsir-tts/${tafsir.id}/${lang}/${pad3(s)}/${pad3(s)}_${pad3(a)}.seg${idx}.mp3`
  try { await fs.access(abs); return { ok: true, url: rel, cached: true } } catch { /* generate */ }
  return once('tts-seg:' + abs, async () => {
    const tr = await readCache(cachePath(tafsir.id, lang, s, a))
    const seg = Array.isArray(tr?.segments) ? tr.segments[idx] : undefined
    const text = String(seg?.text || '').trim()
    if (!text) { const err = new Error(`no segment text at idx ${idx} for ${tafsir.id}/${lang}/${s}:${a}`); err.statusCode = 400; throw err }
    let mp3
    try { mp3 = await ttsSynthesize(text, lang) }
    catch (e) {
      const stripped = text.replace(/\[[^\][]*\]/g, ' ').replace(/\s+/g, ' ').trim()
      if (stripped === text || !stripped) throw e
      mp3 = await ttsSynthesize(stripped, lang) // retry without [audio-tags]
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp-${process.pid}`
    await fs.writeFile(tmp, mp3); await fs.rename(tmp, abs) // atomic
    return { ok: true, url: rel, cached: false }
  })
}

// Ensure the translated transcript exists, then TTS it once. Persisted + shared (get-or-create).
async function getOrCreateTts(tafsir, s, a, lang) {
  const abs = ttsPath(tafsir.id, lang, s, a)
  const rel = `/tafsir-tts/${tafsir.id}/${lang}/${pad3(s)}/${pad3(s)}_${pad3(a)}.mp3`
  try { await fs.access(abs); return { url: rel, cached: true } } catch { /* generate */ }
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
    const mp3 = await ttsSynthesize(text, lang)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp-${process.pid}`
    await fs.writeFile(tmp, mp3); await fs.rename(tmp, abs) // atomic
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
  try { await fs.access(abs); return { url: rel, cached: true } } catch { /* generate */ }
  return once('meaning:' + abs, async () => {
    const raw = await meaningText(s, a, lang)
    if (!raw) { const err = new Error(`no meaning text for ${s}:${a}/${lang}`); err.statusCode = 400; throw err }
    const text = ann ? stripAnnChars(raw) : removeAnn(raw)
    if (!text) { const err = new Error(`empty meaning after annotation strip for ${s}:${a}/${lang}`); err.statusCode = 400; throw err }
    const mp3 = await ttsSynthesize(text, lang)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp-${process.pid}`
    await fs.writeFile(tmp, mp3); await fs.rename(tmp, abs) // atomic
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
  const [transcripts, tts] = await Promise.all([
    walkFiles(TRANSCRIPTS, '/transcripts'),
    walkFiles(TTS_DIR, '/tafsir-tts'),
  ])
  _manifest = { at: Date.now(), data: { transcripts, tts } }
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
    } catch (e) { console.error('[tts-audio]', e?.message || e); return json(res, e?.statusCode === 409 ? 409 : 502, { error: 'audio generation is temporarily unavailable' }) }
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
      if (!SCOPE_ALL && s !== 1 && !(await fileExists(meaningPath(lang, s, a, ann)))) {
        return json(res, 503, { error: 'not_ready' })
      }
      return json(res, 200, { ok: true, ...(await getOrCreateMeaningTts(s, a, lang, ann)), model: EL_TTS_MODEL })
    } catch (e) { console.error('[meaning-audio]', e?.message || e); return json(res, e?.statusCode === 400 ? 400 : 502, { error: 'audio generation is temporarily unavailable' }) }
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
    } catch (e) { console.error('[tts-segment]', e?.message || e); return json(res, e?.statusCode === 400 ? 400 : 502, { error: 'audio generation is temporarily unavailable' }) }
  }
  if (url.pathname === '/api/manifest') {
    try { return json(res, 200, await getManifest()) }
    catch (e) { return json(res, 500, { error: String(e.message || e) }) }
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
        if (text.length < 1) return json(res, 400, { error: 'empty comment' })
        // Attribution: a valid Bearer token OVERRIDES any client-supplied name/verified flag.
        // requireUser refuses insecure transport and costs invalid-token fuzzing (verdict #24-26, #31).
        const authed = await requireUser(req)
        const baseC = { id: crypto.randomUUID(), text, at: new Date().toISOString() }
        const comment = authed
          ? { ...baseC, name: authed.name, userId: authed.id,
              ...(authed.picture ? { picture: authed.picture } : {}), verified: true }
          : { ...baseC, name: clean(d.name, 48) || 'Anonymous', verified: false }
        await appendComment(s, a, comment)
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
