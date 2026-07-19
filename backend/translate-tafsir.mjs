// Translate every Persian tafsir transcript into the target languages, SEGMENT
// by segment so the translation keeps his sentence boundaries + timings (stays
// synced to his voice). Contributes each translation back via /api/transcript,
// exactly like the earlier hand-made ones — just automated and complete.
//
// Provider-agnostic LLM backend (your call, incl. a FREE local model on your Mac):
//   Anthropic:      LLM_PROVIDER=anthropic  ANTHROPIC_API_KEY=...  [LLM_MODEL=claude-...]
//   OpenAI-compat:  LLM_PROVIDER=openai     OPENAI_API_KEY=...  OPENAI_BASE_URL=https://api.openai.com/v1  LLM_MODEL=...
//     (point OPENAI_BASE_URL at Ollama / LM Studio on your Mac for a free local model)
//
//   node translate_tafsir.mjs [short|long|both]   (default both)
import fs from 'node:fs';
import path from 'node:path';

const API = 'http://127.0.0.1:8787';
const SECRET = process.env.CONTRIBUTE_SECRET || '';
const PROVIDER = process.env.LLM_PROVIDER || 'anthropic';
const MODEL = process.env.LLM_MODEL || (PROVIDER === 'anthropic' ? 'claude-sonnet-5' : 'gpt-4o-mini');
const TARGETS = (process.env.TARGET_LANGS || 'en,ar,es,fr,ur,id,ru,de,tr,hi,bn,ms,sw').split(',').map((s) => s.trim());
const LANG_NAME = { en: 'English', ar: 'Arabic', es: 'Spanish', fr: 'French', ur: 'Urdu', id: 'Indonesian',
  ru: 'Russian', de: 'German', tr: 'Turkish', hi: 'Hindi', bn: 'Bengali', ms: 'Malay', sw: 'Swahili' };
const KINDS = { short: { id: 'bazargan-short', faDir: '/srv/transcripts/bazargan-short/fa' },
  long: { id: 'bazargan', faDir: '/srv/transcripts/bazargan/fa' } };
const arg = (process.argv[2] || 'both').toLowerCase();
const order = arg === 'both' ? ['short', 'long'] : [arg];
const CONC = Number(process.env.LLM_CONCURRENCY || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function llm(system, user) {
  if (PROVIDER === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, system, messages: [{ role: 'user', content: user }] }) });
    if (!r.ok) { const e = new Error(`anthropic ${r.status}: ${(await r.text()).slice(0,150)}`); e.status = r.status; throw e; }
    return (await r.json()).content?.[0]?.text || '';
  }
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const r = await fetch(base.replace(/\/$/, '') + '/chat/completions', { method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY || 'local'}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
  if (!r.ok) { const e = new Error(`openai ${r.status}: ${(await r.text()).slice(0,150)}`); e.status = r.status; throw e; }
  return (await r.json()).choices?.[0]?.message?.content || '';
}

const SYS = 'You are an expert translator of Islamic Qur\'an commentary (tafsir) by Abdolali Bazargan. Translate faithfully and naturally, preserving meaning, register, and reverent tone. You will get the source Persian split into numbered segments; return ONLY a JSON array of strings, one translation per segment, SAME length and order. No commentary, no markdown.';

async function translateSegments(segTexts, lang) {
  const numbered = segTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const user = `Translate each numbered Persian segment into ${LANG_NAME[lang] || lang}. Return a JSON array of ${segTexts.length} strings.\n\n${numbered}`;
  let out, tries = 0;
  for (;;) {
    try { out = await llm(SYS, user); break; }
    catch (e) { tries++; if ((e.status === 429 || e.status >= 500) && tries <= 5) { await sleep(2000 * tries); continue; } throw e; }
  }
  const m = out.match(/\[[\s\S]*\]/);
  const arr = JSON.parse(m ? m[0] : out);
  if (!Array.isArray(arr) || arr.length !== segTexts.length) throw new Error(`segment count ${arr?.length} != ${segTexts.length}`);
  return arr.map(String);
}

async function contribute(id, lang, surah, ayah, text, segments) {
  const r = await fetch(`${API}/api/transcript`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-contribute-secret': SECRET },
    body: JSON.stringify({ tafsir: id, lang, surah, ayah, text, segments, source: 'claude-translation', replace: true }) });
  if (!r.ok) throw new Error(`contribute ${r.status}: ${(await r.text()).slice(0,120)}`);
}

function faTranscripts(kind) {
  const dir = KINDS[kind].faDir, items = [];
  const walk = (d) => { for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) { const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.json') && !f.endsWith('.perf.json')) { const m = f.match(/^(\d{3})_(\d{3})\.json$/); if (m) items.push({ path: p, surah: +m[1], ayah: +m[2] }); } } };
  walk(dir); return items;
}

let done = 0, skip = 0, fail = 0;
for (const kind of order) {
  const { id } = KINDS[kind];
  const items = faTranscripts(kind);
  const jobs = [];
  for (const it of items) for (const lang of TARGETS) jobs.push({ ...it, lang, kind });
  console.log(`=== ${kind}: ${items.length} fa transcripts x ${TARGETS.length} langs = ${jobs.length} jobs ===`);
  let i = 0;
  const worker = async () => { for (;;) { const idx = i++; if (idx >= jobs.length) return; const j = jobs[idx];
    const outPath = path.join(path.dirname(j.path).replace('/fa/', `/${j.lang}/`).replace('/bazargan/fa', `/bazargan/${j.lang}`).replace('/bazargan-short/fa', `/bazargan-short/${j.lang}`), path.basename(j.path));
    // skip if translation already exists
    const exists = fs.existsSync(`/srv/transcripts/${id}/${j.lang}/${String(j.surah).padStart(3,'0')}/${String(j.surah).padStart(3,'0')}_${String(j.ayah).padStart(3,'0')}.json`);
    if (exists) { skip++; continue; }
    try {
      const fa = JSON.parse(fs.readFileSync(j.path, 'utf8'));
      const segs = Array.isArray(fa.segments) && fa.segments.length ? fa.segments : [{ s: 0, e: 0, text: fa.text }];
      const tr = await translateSegments(segs.map((s) => s.text), j.lang);
      const outSegs = segs.map((s, k) => ({ s: s.s, e: s.e, text: tr[k] }));
      await contribute(id, j.lang, j.surah, j.ayah, tr.join(' '), outSegs);
      done++;
    } catch (e) { console.error(`[fail] ${id} ${j.lang} ${j.surah}:${j.ayah}: ${e.message}`); fail++; }
    if ((done + skip + fail) % 20 === 0) console.log(`[${done+skip+fail}/${jobs.length}] done=${done} skip=${skip} fail=${fail}`);
  } };
  await Promise.all(Array.from({ length: CONC }, worker));
}
console.log(`=== TRANSLATE DONE done=${done} skip=${skip} fail=${fail} ===`);
