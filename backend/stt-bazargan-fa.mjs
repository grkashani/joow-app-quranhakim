// Batch STT the Bazargan Persian recordings → transcript JSON + karaoke sidecar,
// for Farsi "Original" mode. Standalone (does NOT touch the server's global
// ALLOW_ALL_SURAHS scope gate, so it can't trigger client-side spend). Idempotent
// and resumable: skips any ayah whose sidecar already exists.
//
// Usage:  node stt_bazargan_fa.mjs short   (or: long | both)
//
// For each ayah it:
//   1. POSTs the human mp3 to ElevenLabs Scribe (language_code=fa, word timings)
//   2. writes /srv/transcripts/<id>/fa/<c3>/<c3>_<v3>.json  { text, words:[{t,s,e}], ... }
//   3. writes <audioDir>/<c3>_<v3>.words.json               { words:[{w,s,e}], dur, text }
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const EL_KEY = process.env.ELEVENLABS_API_KEY || '';
const EL_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v2';
if (!EL_KEY) { console.error('no ELEVENLABS_API_KEY'); process.exit(1); }

const KINDS = {
  short: { id: 'bazargan-short', audioDir: '/srv/tafsir-short', trDir: '/srv/transcripts/bazargan-short/fa' },
  long:  { id: 'bazargan',       audioDir: '/srv/tafsir/ssn',   trDir: '/srv/transcripts/bazargan/fa' },
};
const arg = (process.argv[2] || 'short').toLowerCase();
const order = arg === 'both' ? ['short', 'long'] : [arg];
if (order.some((k) => !KINDS[k])) { console.error('usage: node stt_bazargan_fa.mjs short|long|both'); process.exit(1); }

const CONCURRENCY = Number(process.env.STT_CONCURRENCY || 4);
const round = (x, n = 3) => { const p = 10 ** n; return Math.round((x || 0) * p) / p; };
const pad3 = (n) => String(n).padStart(3, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sttOnce(mp3) {
  const buf = await fsp.readFile(mp3);
  const form = new FormData();
  form.append('model_id', EL_MODEL);
  form.append('language_code', 'fa');
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false'); // clean alignment (no [music]/[noise] tokens)
  form.append('diarize', 'false');
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(mp3));
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', headers: { 'xi-api-key': EL_KEY }, body: form,
  });
  if (!res.ok) { const t = await res.text(); const e = new Error(`STT ${res.status}: ${t.slice(0, 200)}`); e.status = res.status; throw e; }
  return res.json();
}

// One ayah: STT → transcript + sidecar. Returns 'done' | 'skip' | 'fail'.
async function processAyah(kind, c3, base, mp3) {
  const K = KINDS[kind];
  const sidecar = path.join(K.audioDir, c3, base + '.words.json');
  if (fs.existsSync(sidecar)) return 'skip';
  let d, tries = 0;
  for (;;) {
    try { d = await sttOnce(mp3); break; }
    catch (e) {
      tries++;
      if ((e.status === 429 || e.status >= 500) && tries <= 4) { await sleep(1500 * tries); continue; }
      console.error(`  [fail] ${kind} ${base}: ${e.message}`); return 'fail';
    }
  }
  const rawWords = Array.isArray(d.words) ? d.words.filter((w) => w.type !== 'spacing') : [];
  const trWords = rawWords.map((w) => ({
    t: w.text, s: round(w.start, 2), e: round(w.end, 2),
    ...(w.type === 'audio_event' ? { ev: 1 } : {}),
    ...(typeof w.logprob === 'number' ? { lp: round(w.logprob) } : {}),
  }));
  const text = d.text || '';
  // transcript (for the reader's displayed text + future features)
  const trPath = path.join(K.trDir, c3, base + '.json');
  await fsp.mkdir(path.dirname(trPath), { recursive: true });
  await fsp.writeFile(trPath, JSON.stringify({
    text, lang: 'fa', source: 'bazargan-stt', model: EL_MODEL,
    languageProbability: typeof d.language_probability === 'number' ? d.language_probability : null,
    createdAt: new Date().toISOString(), words: trWords,
  }));
  // karaoke sidecar (spoken words only; {w,s,e})
  const kw = trWords.filter((w) => !w.ev && typeof w.t === 'string' && w.t.trim() && w.e >= w.s)
    .map((w) => ({ w: w.t, s: w.s, e: w.e }));
  const dur = kw.reduce((m, w) => Math.max(m, w.e), 0);
  await fsp.writeFile(sidecar, JSON.stringify({ words: kw, dur, text, source: 'bazargan-stt' }));
  return 'done';
}

// Optional surah allow-list (comma-separated), for a controlled validation run.
const ONLY = (process.env.STT_SURAHS || '').split(',').map((x) => x.trim()).filter(Boolean);
const onlyOk = (c3) => !ONLY.length || ONLY.includes(String(Number(c3))) || ONLY.includes(c3);

// Build the full work list from the mp3s that actually exist on disk.
function workList(kind) {
  const K = KINDS[kind];
  const items = [];
  if (!fs.existsSync(K.audioDir)) return items;
  for (const c3 of fs.readdirSync(K.audioDir).filter((d) => /^\d{3}$/.test(d) && onlyOk(d)).sort()) {
    const dir = path.join(K.audioDir, c3);
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(\d{3}_\d{3})\.mp3$/);
      if (m) items.push({ kind, c3, base: m[1], mp3: path.join(dir, f) });
    }
  }
  return items;
}

async function runPool(items) {
  let i = 0, done = 0, skip = 0, fail = 0;
  const t0 = Date.now();
  const worker = async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      const it = items[idx];
      const r = await processAyah(it.kind, it.c3, it.base, it.mp3);
      if (r === 'done') done++; else if (r === 'skip') skip++; else fail++;
      const n = done + skip + fail;
      if (n % 25 === 0 || n === items.length) {
        const secs = (Date.now() - t0) / 1000;
        const rate = done / Math.max(secs, 1);
        const remain = (items.length - n) / Math.max(rate, 0.001);
        console.log(`[${n}/${items.length}] done=${done} skip=${skip} fail=${fail} | ${rate.toFixed(2)}/s | ~${Math.round(remain / 60)}m left`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { done, skip, fail };
}

for (const kind of order) {
  const items = workList(kind);
  console.log(`=== ${kind} (${KINDS[kind].id}): ${items.length} ayahs, concurrency ${CONCURRENCY} ===`);
  const r = await runPool(items);
  console.log(`=== ${kind} COMPLETE: ${JSON.stringify(r)} ===`);
}
console.log('ALL DONE');
