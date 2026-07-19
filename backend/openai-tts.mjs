// PREPARED (not yet run) — OpenAI TTS generator, provider-keyed. Ready to run the
// moment an OPENAI_API_KEY exists. Writes to the provider taxonomy so OpenAI audio
// is categorized separately from ElevenLabs and the original human recordings:
//   /srv/assets/openai/<kind>/<lang>/<c3>/<c3>_<v3>.mp3  (+ .gen.json)
//
// NOTE on karaoke: OpenAI /v1/audio/speech returns audio only — no word timings.
// So this writes audio + provenance; word-timing sidecars need a follow-up align
// pass (ElevenLabs Scribe STT of the output, or a local forced aligner). Until a
// licensed Bazargan clone exists, use a deep male preset (voice=onyx) as a stand-in.
//
//   OPENAI_API_KEY=... node openai_tts.mjs <kind:meaning|tafsir-short|tafsir-long> [langs] [voice]
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const VOICE = process.argv[4] || process.env.OPENAI_TTS_VOICE || 'onyx';
const KIND = process.argv[2] || 'meaning';
const LANGS = (process.argv[3] || process.env.TTS_LANGS || 'fa,en').split(',').map((s) => s.trim()).filter(Boolean);
const CONC = Number(process.env.TTS_CONCURRENCY || 6);
const WEBROOT = process.env.WEBROOT || '/var/www/quranner';
const OUT = `/srv/assets/openai/${KIND}`;
if (!KEY) { console.error('set OPENAI_API_KEY to run (this script is prepared, not yet used)'); process.exit(1); }

const pad3 = (n) => String(n).padStart(3, '0');
const stripAnn = (t) => String(t || '').replace(/[[\]()﴾﴿]/g, ' ').replace(/\s+/g, ' ').trim();
const surahCache = new Map();
function meaningText(s, a, lang) {
  if (!surahCache.has(s)) { try { surahCache.set(s, JSON.parse(fs.readFileSync(path.join(WEBROOT, 'data', 'surah', `${s}.json`), 'utf8'))); } catch { surahCache.set(s, null); } }
  const j = surahCache.get(s); if (!j) return '';
  const ay = (j.ayahs || []).find((x) => Number(x.n) === a); if (!ay) return '';
  return stripAnn(lang === 'fa' ? ay.fa : lang === 'en' ? ay.en : ay.t?.[lang]);
}

async function tts(text) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, voice: VOICE, input: text, response_format: 'mp3' }),
  });
  if (!res.ok) { const e = new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 160)}`); e.status = res.status; throw e; }
  return Buffer.from(await res.arrayBuffer());
}

function work() {
  const items = [];
  for (let s = 1; s <= 114; s++) { let j; try { j = JSON.parse(fs.readFileSync(path.join(WEBROOT, 'data', 'surah', `${s}.json`), 'utf8')); } catch { continue; }
    for (const ay of (j.ayahs || [])) for (const lang of LANGS) items.push({ s, a: Number(ay.n), lang }); }
  return items;
}

const items = work();
console.log(`=== OpenAI ${KIND} TTS: ${items.length} clips, model=${MODEL}, voice=${VOICE}, langs=${LANGS.join('+')} ===`);
let i = 0, done = 0, skip = 0, fail = 0;
async function worker() {
  for (;;) { const idx = i++; if (idx >= items.length) return; const { s, a, lang } = items[idx];
    const dir = path.join(OUT, lang, pad3(s)); const mp3 = path.join(dir, `${pad3(s)}_${pad3(a)}.mp3`);
    if (fs.existsSync(mp3)) { skip++; continue; }
    const text = KIND === 'meaning' ? meaningText(s, a, lang) : ''; // tafsir text source = transcript (wire when needed)
    if (!text) { continue; }
    try { const buf = await tts(text); await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(mp3, buf);
      await fsp.writeFile(mp3.replace(/\.mp3$/, '.gen.json'), JSON.stringify({ provider: 'openai', model: MODEL, voice: VOICE, lang, kind: KIND, chars: text.length, text }));
      done++; }
    catch (e) { if (e.status === 429 && idx < items.length) { await new Promise((r) => setTimeout(r, 2000)); i--; continue; } console.error(`[fail] ${lang} ${s}:${a}: ${e.message}`); fail++; }
    if ((done + skip + fail) % 25 === 0) console.log(`[${done + skip + fail}/${items.length}] done=${done} skip=${skip} fail=${fail}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`=== DONE done=${done} skip=${skip} fail=${fail} ===`);
