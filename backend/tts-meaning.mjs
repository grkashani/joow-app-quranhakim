// Batch-generate the "exact meaning" (translation) AI-TTS for every ayah, in the
// languages whose meaning text we actually have (fa + en for the whole Qur'an).
// Standalone: uses the MAIN ElevenLabs key directly (no server restart, no scope
// gate, no tafsir-TTS exposure). Output matches the server's meaning-tts exactly:
//   /srv/meaning-tts/<lang>/<c3>/<c3>_<v3>.mp3   + .words.json {words:[{w,s,e}],dur,text}
// Idempotent/resumable: skips any clip whose mp3 + sidecar already exist.
//
// Usage:  node tts_meaning.mjs            (langs from $TTS_LANGS, default "fa,en")
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const EL_KEY = process.env.ELEVENLABS_API_KEY || '';
const EL_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_v3';
const EL_TTS_FMT = process.env.ELEVENLABS_TTS_OUTPUT_FORMAT || 'mp3_44100_128';
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75 };
const WEBROOT = process.env.WEBROOT || '/var/www/quranner';
const MEANING_DIR = '/srv/meaning-tts';
const LANGS = (process.env.TTS_LANGS || 'fa,en').split(',').map((x) => x.trim()).filter(Boolean);
const CONCURRENCY = Number(process.env.TTS_CONCURRENCY || 6);
const ONLY = (process.env.TTS_SURAHS || '').split(',').map((x) => x.trim()).filter(Boolean);
if (!EL_KEY) { console.error('no ELEVENLABS_API_KEY'); process.exit(1); }

const pad3 = (n) => String(n).padStart(3, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const voiceFor = (lang) => process.env[`ELEVENLABS_VOICE_${lang.toUpperCase()}`] || process.env.ELEVENLABS_VOICE_ID || '';
// ann=true reading: keep the translator's inserted words, drop only the brackets.
const stripAnnChars = (t) => String(t || '').replace(/[[\]()﴾﴿]/g, ' ').replace(/\s+/g, ' ').trim();

// Group per-character alignment into words [{w,s,e}] (seconds) — mirrors server charsToWords.
function charsToWords(chars, starts, ends) {
  const words = []; let cur = '', s = null, e = 0;
  const flush = () => { if (cur.trim()) words.push({ w: cur, s: +(s ?? 0).toFixed(3), e: +e.toFixed(3) }); cur = ''; s = null; };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\s/.test(c)) flush();
    else { if (s === null) s = starts[i] ?? 0; cur += c; e = ends[i] ?? e; }
  }
  flush();
  return words;
}

const surahCache = new Map();
function meaningText(s, a, lang) {
  if (!surahCache.has(s)) {
    try { surahCache.set(s, JSON.parse(fs.readFileSync(path.join(WEBROOT, 'data', 'surah', `${s}.json`), 'utf8'))); }
    catch { surahCache.set(s, null); }
  }
  const j = surahCache.get(s); if (!j) return '';
  const ay = (j.ayahs || []).find((x) => Number(x.n) === a); if (!ay) return '';
  const t = lang === 'fa' ? ay.fa : lang === 'en' ? ay.en : ay.t?.[lang];
  return stripAnnChars(t);
}

let charsUsed = 0;
async function ttsOnce(text, lang) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceFor(lang))}/with-timestamps?output_format=${EL_TTS_FMT}`;
  const body = { text, model_id: EL_TTS_MODEL, voice_settings: VOICE_SETTINGS, language_code: lang };
  const res = await fetch(url, { method: 'POST', headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text(); const e = new Error(`TTS ${res.status}: ${t.slice(0, 200)}`); e.status = res.status; throw e; }
  const j = await res.json();
  const mp3 = Buffer.from(j.audio_base64 || '', 'base64');
  if (!mp3.length) throw new Error('empty audio');
  const al = j.alignment || {};
  return { mp3, words: charsToWords(al.characters || [], al.character_start_times_seconds || [], al.character_end_times_seconds || []) };
}

async function processClip(lang, s, a) {
  const dir = path.join(MEANING_DIR, lang, pad3(s));
  const mp3Path = path.join(dir, `${pad3(s)}_${pad3(a)}.mp3`);
  const sidecar = mp3Path.replace(/\.mp3$/, '.words.json');
  if (fs.existsSync(mp3Path) && fs.existsSync(sidecar)) return 'skip';
  const text = meaningText(s, a, lang);
  if (!text) return 'notext';
  let r, tries = 0;
  for (;;) {
    try { r = await ttsOnce(text, lang); break; }
    catch (e) { tries++; if ((e.status === 429 || e.status >= 500) && tries <= 5) { await sleep(1500 * tries); continue; } console.error(`  [fail] ${lang} ${s}:${a}: ${e.message}`); return 'fail'; }
  }
  charsUsed += text.length;
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${mp3Path}.tmp-${process.pid}-${a}`;
  await fsp.writeFile(tmp, r.mp3); await fsp.rename(tmp, mp3Path);
  const dur = r.words.reduce((m, w) => Math.max(m, w.e), 0);
  await fsp.writeFile(sidecar, JSON.stringify({ words: r.words, dur, text }));
  return 'done';
}

function workList() {
  const items = [];
  for (let s = 1; s <= 114; s++) {
    if (ONLY.length && !ONLY.includes(String(s))) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(WEBROOT, 'data', 'surah', `${s}.json`), 'utf8')); } catch { continue; }
    for (const ay of (j.ayahs || [])) for (const lang of LANGS) items.push({ lang, s, a: Number(ay.n) });
  }
  return items;
}

const items = workList();
console.log(`=== meaning TTS: ${items.length} clips, langs=${LANGS.join('+')}, model=${EL_TTS_MODEL}, concurrency=${CONCURRENCY} ===`);
let i = 0, done = 0, skip = 0, fail = 0, notext = 0;
const t0 = Date.now();
async function worker() {
  for (;;) {
    const idx = i++; if (idx >= items.length) return;
    const it = items[idx];
    const r = await processClip(it.lang, it.s, it.a);
    if (r === 'done') done++; else if (r === 'skip') skip++; else if (r === 'notext') notext++; else fail++;
    const n = done + skip + fail + notext;
    if (n % 25 === 0 || n === items.length) {
      const secs = (Date.now() - t0) / 1000, rate = done / Math.max(secs, 1);
      console.log(`[${n}/${items.length}] done=${done} skip=${skip} notext=${notext} fail=${fail} | ${rate.toFixed(2)}/s | ~${Math.round((items.length - n) / Math.max(rate, 0.001) / 60)}m | ~$${(charsUsed / 1e6 * 100).toFixed(1)}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`=== DONE done=${done} skip=${skip} notext=${notext} fail=${fail} chars=${charsUsed} est$=${(charsUsed / 1e6 * 100).toFixed(1)} ===`);
