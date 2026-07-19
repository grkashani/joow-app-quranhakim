// migrate-assets.mjs — idempotent migration from the LEGACY asset layout to the
// provider-keyed layout. Safe to run repeatedly; safe to run while the old layout
// is still being written to (it only ADDS new-layout names, never deletes).
//
// LEGACY:
//   transcript: /srv/transcripts/<tafsir>/<lang>/<c3>/<c3>_<v3>.json   (provider is the json `source` field)
//   tts audio : /srv/tafsir-tts/<tafsir>/<lang>/<c3>/<c3>_<v3>.mp3     (provider implicitly elevenlabs)
//   human aud : /srv/tafsir/ssn/<c3>/<c3>_<v3>.mp3                     (NOT migrated — aliased in place)
//
// NEW:
//   transcript: /srv/transcripts/<tafsir>/<provider>/<lang>/<c3>/<c3>_<v3>.json
//   audio     : /srv/audio/<tafsir>/<provider>/<lang>/<c3>/<c3>_<v3>.mp3
//
// Strategy: HARDLINK legacy -> new (same filesystem, one inode, ~0 bytes, both names
// valid during the transition). Falls back to copy across devices. `source` in each
// transcript json decides its provider. Run with --commit to actually link (default dry-run).
//
//   node scripts/migrate-assets.mjs                 # dry-run, prints the plan
//   node scripts/migrate-assets.mjs --commit        # perform hardlinks
//   node scripts/migrate-assets.mjs --commit --copy # force copy instead of hardlink
//
// ENV: TRANSCRIPTS_DIR=/srv/transcripts  TTS_DIR=/srv/tafsir-tts  AUDIO_DIR=/srv/audio
import fs from 'node:fs/promises'
import path from 'node:path'

const TRANSCRIPTS = process.env.TRANSCRIPTS_DIR || '/srv/transcripts'
const TTS_DIR     = process.env.TTS_DIR         || '/srv/tafsir-tts'
const AUDIO_DIR   = process.env.AUDIO_DIR       || '/srv/audio'
const COMMIT = process.argv.includes('--commit')
const COPY   = process.argv.includes('--copy')

// Legacy transcript `source` field -> canonical provider id.
const SOURCE_TO_PROVIDER = {
  'elevenlabs-scribe': 'elevenlabs',
  'translation':       'claude',
  'device-ios':        'device',
  'device':            'device',
}
const providerFromSource = (src) => SOURCE_TO_PROVIDER[src] || 'elevenlabs' // safe default: original-lang scribe

const stats = { transcripts: 0, tts: 0, linked: 0, skipped: 0, errors: 0 }

async function exists(p) { try { await fs.access(p); return true } catch { return false } }
async function walk(dir) {           // yields every file under dir
  const out = []
  let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(full))
    else out.push(full)
  }
  return out
}
async function link(src, dst) {
  if (await exists(dst)) { stats.skipped++; return }   // idempotent
  if (!COMMIT) { console.log(`  PLAN ${src}\n    -> ${dst}`); stats.linked++; return }
  await fs.mkdir(path.dirname(dst), { recursive: true })
  try {
    if (COPY) await fs.copyFile(src, dst)
    else      await fs.link(src, dst)                  // hardlink: 0 extra bytes
  } catch (e) {
    if (e.code === 'EXDEV' && !COPY) { await fs.copyFile(src, dst) } // cross-device -> copy
    else { stats.errors++; console.error(`  ERROR ${src}: ${e.message}`); return }
  }
  stats.linked++
}

// ---- 1) transcripts: /<tafsir>/<lang>/<c3>/f.json  ->  /<tafsir>/<provider>/<lang>/<c3>/f.json
async function migrateTranscripts() {
  for (const src of await walk(TRANSCRIPTS)) {
    if (!src.endsWith('.json')) continue
    const rel = path.relative(TRANSCRIPTS, src).split(path.sep)   // [tafsir, lang, c3, file]  (LEGACY)
    if (rel.length !== 4) continue                                // already-migrated 5-deep paths are skipped
    const [tafsir, lang, c3, file] = rel
    stats.transcripts++
    let provider = 'elevenlabs'
    try { provider = providerFromSource(JSON.parse(await fs.readFile(src, 'utf8')).source) }
    catch { stats.errors++; continue }
    await link(src, path.join(TRANSCRIPTS, tafsir, provider, lang, c3, file))
  }
}

// ---- 2) tts audio: /tafsir-tts/<tafsir>/<lang>/<c3>/f.mp3  ->  /audio/<tafsir>/elevenlabs/<lang>/<c3>/f.mp3
async function migrateTts() {
  for (const src of await walk(TTS_DIR)) {
    if (!src.endsWith('.mp3')) continue
    const rel = path.relative(TTS_DIR, src).split(path.sep)       // [tafsir, lang, c3, file]
    if (rel.length !== 4) continue
    const [tafsir, lang, c3, file] = rel
    stats.tts++
    await link(src, path.join(AUDIO_DIR, tafsir, 'elevenlabs', lang, c3, file))
  }
}

console.log(`migrate-assets: mode=${COMMIT ? (COPY ? 'COMMIT/copy' : 'COMMIT/hardlink') : 'DRY-RUN'}`)
await migrateTranscripts()
await migrateTts()
console.log(`\nsummary: transcripts=${stats.transcripts} tts=${stats.tts} ` +
            `linked=${stats.linked} skipped(existing)=${stats.skipped} errors=${stats.errors}`)
if (!COMMIT) console.log('DRY-RUN — re-run with --commit to apply.')
