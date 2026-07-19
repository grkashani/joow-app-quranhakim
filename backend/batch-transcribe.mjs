#!/usr/bin/env node
// backend/batch-transcribe.mjs
//
// Bulk-populate JoowQuran transcripts by driving the LOCAL transcription API
// (GET /api/transcript) across a range of surahs/ayahs.
//
// The API is get-or-create: on a cache miss it runs ElevenLabs Scribe (STT) on
// the original-language clip and (optionally) translates it, then persists the
// result under /srv/transcripts/<tafsir>/<lang>/<c3>/<c3>_<v3>.json — which nginx
// then serves statically. This script simply "warms" that cache ayah by ayah.
//
// It NEVER re-transcribes: before hitting the API it checks whether the static
// cache file already exists on disk and skips it if so.
//
// Usage:
//   node backend/batch-transcribe.mjs <tafsir> <lang> <range> [--conc N] [--dry-run]
//
//   <tafsir>   tafsir id, e.g. "bazargan"
//   <lang>     target transcript language, e.g. "fa" (original) or "en" (translated)
//   <range>    "all" | "5" | "2-10" | "1,4,7" | "2-10,36,55-60"
//
//   --conc N   bounded concurrency (default 3, or env CONCURRENCY)
//   --dry-run  plan only: report how many are cached vs. would-be-fetched, no calls
//
// Env overrides:
//   API_BASE         default http://127.0.0.1:8787
//   WEBROOT          default /var/www/quranner   (holds data/surahs.json for ttlVer)
//   TRANSCRIPTS_DIR  default /srv/transcripts     (static cache root; must match the API)
//   CONCURRENCY      default 3
//   MAX_RETRIES      default 3   (transient attempts per ayah; 4xx is terminal)
//   REQUEST_TIMEOUT  default 300000 ms (per request; STT can be slow)
//
// Exit code is non-zero if any ayah ended in a permanent failure.

import fs from 'node:fs/promises'
import path from 'node:path'

const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const WEBROOT = process.env.WEBROOT || '/var/www/quranner'
const TRANSCRIPTS = process.env.TRANSCRIPTS_DIR || '/srv/transcripts'
const MAX_RETRIES = Math.max(1, Number(process.env.MAX_RETRIES || 3))
const REQUEST_TIMEOUT = Math.max(1000, Number(process.env.REQUEST_TIMEOUT || 300000))

const pad3 = (n) => String(n).padStart(3, '0')

// Mirrors the API's cachePath(): /srv/transcripts/<id>/<lang>/<c3>/<c3>_<v3>.json
const cachePath = (id, lang, s, a) =>
  path.join(TRANSCRIPTS, id, lang, pad3(s), `${pad3(s)}_${pad3(a)}.json`)

const fileExists = async (p) => {
  try { await fs.access(p); return true } catch { return false }
}

function parseArgs(argv) {
  const positional = []
  let conc = Number(process.env.CONCURRENCY || 3)
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--conc' || arg === '--concurrency') conc = Number(argv[++i])
    else if (arg.startsWith('--conc=')) conc = Number(arg.split('=')[1])
    else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`)
    else positional.push(arg)
  }
  const [tafsir, lang, range] = positional
  if (!tafsir || !lang || !range) {
    throw new Error(
      'usage: node backend/batch-transcribe.mjs <tafsir> <lang> <range> [--conc N] [--dry-run]',
    )
  }
  if (!Number.isFinite(conc) || conc < 1) throw new Error(`bad --conc: ${conc}`)
  return { tafsir, lang, range, conc: Math.floor(conc), dryRun }
}

async function loadSurahs() {
  const p = path.join(WEBROOT, 'data', 'surahs.json')
  const raw = await fs.readFile(p, 'utf8')
  const arr = JSON.parse(raw)
  if (!Array.isArray(arr)) throw new Error(`surahs.json is not an array: ${p}`)
  return arr // [{ num, nameFa, nameEn, ttlVer }, ...]
}

// Turn a range spec into a sorted, de-duped list of surah numbers present in surahs.json.
function selectSurahs(range, surahs) {
  const valid = new Set(surahs.map((s) => s.num))
  if (range.toLowerCase() === 'all') return surahs.map((s) => s.num).sort((a, b) => a - b)
  const picked = new Set()
  for (const part of range.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) throw new Error(`bad range segment: "${part}"`)
    const lo = Number(m[1])
    const hi = m[2] ? Number(m[2]) : lo
    if (hi < lo) throw new Error(`descending range segment: "${part}"`)
    for (let n = lo; n <= hi; n++) {
      if (!valid.has(n)) throw new Error(`surah ${n} not in surahs.json (valid 1..${surahs.length})`)
      picked.add(n)
    }
  }
  return [...picked].sort((a, b) => a - b)
}

// Build the full work list of {surah, ayah} across the selected surahs.
function buildTasks(surahNums, surahs) {
  const byNum = new Map(surahs.map((s) => [s.num, s]))
  const tasks = []
  for (const num of surahNums) {
    const meta = byNum.get(num)
    const total = Number(meta?.ttlVer)
    if (!Number.isInteger(total) || total < 1) {
      throw new Error(`surah ${num} has no valid ttlVer in surahs.json`)
    }
    for (let a = 1; a <= total; a++) tasks.push({ surah: num, ayah: a })
  }
  return tasks
}

function transcriptUrl(tafsir, lang, surah, ayah) {
  const u = new URL('/api/transcript', API_BASE)
  u.searchParams.set('tafsir', tafsir)
  u.searchParams.set('surah', String(surah))
  u.searchParams.set('ayah', String(ayah))
  u.searchParams.set('lang', lang)
  return u.toString()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Fetch one transcript with retry. Returns { ok, status } | throws only on give-up.
// Transient (network error / timeout / 5xx) -> retry up to MAX_RETRIES.
// 4xx -> terminal (no retry).
async function fetchWithRetry(url) {
  let lastErr
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      clearTimeout(timer)
      if (res.ok) return { ok: true, status: res.status }
      const body = (await res.text().catch(() => '')).slice(0, 200)
      if (res.status >= 400 && res.status < 500) {
        // Terminal: bad params, missing tafsir, etc. Do not retry.
        const err = new Error(`HTTP ${res.status} ${body}`)
        err.terminal = true
        throw err
      }
      // 5xx -> transient
      lastErr = new Error(`HTTP ${res.status} ${body}`)
    } catch (e) {
      clearTimeout(timer)
      if (e.terminal) throw e // don't retry 4xx
      lastErr = e.name === 'AbortError' ? new Error(`timeout after ${REQUEST_TIMEOUT}ms`) : e
    }
    if (attempt < MAX_RETRIES) await sleep(Math.min(15000, 1000 * 2 ** (attempt - 1)))
  }
  throw lastErr || new Error('unknown transient failure')
}

// Simple bounded-concurrency worker pool over an index cursor.
async function runPool(items, conc, worker) {
  let next = 0
  const runners = Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      await worker(items[i], i)
    }
  })
  await Promise.all(runners)
}

async function main() {
  const { tafsir, lang, range, conc, dryRun } = parseArgs(process.argv.slice(2))
  const surahs = await loadSurahs()
  const surahNums = selectSurahs(range, surahs)
  const tasks = buildTasks(surahNums, surahs)
  const total = tasks.length

  console.log(
    `[batch] tafsir=${tafsir} lang=${lang} surahs=[${surahNums[0]}..${surahNums[surahNums.length - 1]}]` +
      ` (${surahNums.length}) ayahs=${total} conc=${conc}${dryRun ? ' DRY-RUN' : ''}`,
  )
  console.log(`[batch] API=${API_BASE}  cache=${TRANSCRIPTS}`)

  const counters = { done: 0, skipped: 0, fetched: 0, failed: 0 }
  const failures = []
  const started = Date.now()

  await runPool(tasks, dryRun ? Math.max(conc, 16) : conc, async (t) => {
    const { surah, ayah } = t
    const label = `${pad3(surah)}_${pad3(ayah)}`

    // Skip if the static cache file already exists — never re-transcribe.
    if (await fileExists(cachePath(tafsir, lang, surah, ayah))) {
      counters.skipped++
      counters.done++
      return
    }

    if (dryRun) {
      counters.done++
      return
    }

    try {
      await fetchWithRetry(transcriptUrl(tafsir, lang, surah, ayah))
      counters.fetched++
      counters.done++
      // Progress line only for real fetches to keep output readable on big runs.
      if (counters.fetched % 10 === 0 || counters.done === total) {
        process.stdout.write(
          `\r[batch] ${counters.done}/${total}  fetched=${counters.fetched} skipped=${counters.skipped} failed=${counters.failed}   `,
        )
      }
    } catch (e) {
      counters.failed++
      counters.done++
      failures.push({ surah, ayah, error: String(e.message || e) })
      process.stderr.write(`\n[batch] FAIL ${label}: ${String(e.message || e)}\n`)
    }
  })

  const secs = ((Date.now() - started) / 1000).toFixed(1)
  process.stdout.write('\n')
  console.log('─'.repeat(60))
  if (dryRun) {
    console.log(
      `[batch] DRY-RUN summary: total=${total} already-cached=${counters.skipped} ` +
        `would-fetch=${total - counters.skipped}`,
    )
  } else {
    console.log(
      `[batch] summary: total=${total} fetched=${counters.fetched} ` +
        `skipped(cached)=${counters.skipped} failed=${counters.failed} in ${secs}s`,
    )
  }
  if (failures.length) {
    console.log(`[batch] ${failures.length} permanent failure(s):`)
    for (const f of failures.slice(0, 50)) {
      console.log(`  - ${pad3(f.surah)}_${pad3(f.ayah)}: ${f.error}`)
    }
    if (failures.length > 50) console.log(`  ... and ${failures.length - 50} more`)
  }

  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  console.error(`[batch] fatal: ${String(e.message || e)}`)
  process.exit(2)
})
