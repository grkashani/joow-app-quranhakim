// Provenance manifest — one catalog of every asset, categorized by PROVIDER so
// we always know what we have and who made it: `original` (human recordings),
// `elevenlabs` (AI TTS + Scribe STT), and any future engine (`openai`, ...).
// Non-destructive: it indexes the assets where they already live; the reader
// keeps its current paths. New providers write under /srv/assets/<provider>/...
// (see docs). Output: /srv/manifest.json  (+ a compact console summary).
import fs from 'node:fs';
import path from 'node:path';

const pad3 = (n) => String(n).padStart(3, '0');
// count *_*.mp3 (or .json) per surah under a root laid out as <root>/<c3>/<file>
function scanFlat(root, ext) {
  const bySurah = {}; let total = 0, bytes = 0;
  if (!fs.existsSync(root)) return { surahs: 0, ayahs: 0, bytes: 0, bySurah };
  for (const c3 of fs.readdirSync(root).filter((d) => /^\d{3}$/.test(d))) {
    let n = 0;
    for (const f of fs.readdirSync(path.join(root, c3))) {
      if (f.endsWith(ext) && /^\d{3}_\d{3}/.test(f)) { n++; total++; try { bytes += fs.statSync(path.join(root, c3, f)).size; } catch {} }
    }
    if (n) bySurah[String(Number(c3))] = n;
  }
  return { surahs: Object.keys(bySurah).length, ayahs: total, bytes, bySurah };
}
// count per <root>/<lang>/<c3>/<file>
function scanByLang(root, ext) {
  const out = {};
  if (!fs.existsSync(root)) return out;
  for (const lang of fs.readdirSync(root)) {
    const p = path.join(root, lang);
    if (fs.statSync(p).isDirectory()) { const s = scanFlat(p, ext); if (s.ayahs) out[lang] = { surahs: s.surahs, ayahs: s.ayahs, bytes: s.bytes }; }
  }
  return out;
}

const M = {
  schema: 'quranhakim/manifest@1',
  note: 'Every asset categorized by provider. "original"=human; others=synthetic. Non-destructive index.',
  providers: {
    original: { label: 'Human recordings', voices: { tafsir: 'Abdolali Bazargan', recitation: 'everyayah reciters' } },
    elevenlabs: { label: 'ElevenLabs', engines: { tts: 'eleven_v3', stt: 'scribe_v2' } },
    openai: { label: 'OpenAI', status: 'planned', engines: { tts: 'tts-1 / gpt-4o-mini-tts' } },
  },
  assets: {
    // ORIGINAL — the crown jewels for reconstruction. Never delete.
    'tafsir-long/original': { provider: 'original', kind: 'tafsir-long', voice: 'bazargan-human', role: 'source-of-truth',
      path: '/srv/tafsir/ssn/{c3}/{c3}_{v3}.mp3', coverage: scanFlat('/srv/tafsir/ssn', '.mp3') },
    'tafsir-short/original': { provider: 'original', kind: 'tafsir-short', voice: 'bazargan-human', role: 'source-of-truth',
      path: '/srv/tafsir-short/{c3}/{c3}_{v3}.mp3', coverage: scanFlat('/srv/tafsir-short', '.mp3') },
    // ELEVENLABS — synthetic tafsir + meaning, per language
    'tafsir-long/elevenlabs': { provider: 'elevenlabs', kind: 'tafsir-long',
      path: '/srv/tafsir-tts/bazargan/{lang}/{c3}/{c3}_{v3}.mp3', byLang: scanByLang('/srv/tafsir-tts/bazargan', '.mp3') },
    'tafsir-short/elevenlabs': { provider: 'elevenlabs', kind: 'tafsir-short',
      path: '/srv/tafsir-tts/bazargan-short/{lang}/{c3}/{c3}_{v3}.mp3', byLang: scanByLang('/srv/tafsir-tts/bazargan-short', '.mp3') },
    'meaning/elevenlabs': { provider: 'elevenlabs', kind: 'meaning',
      path: '/srv/meaning-tts/{lang}/{c3}/{c3}_{v3}.mp3', byLang: scanByLang('/srv/meaning-tts', '.mp3') },
    // DERIVED — expensive to regenerate (paid STT), keep + back up
    'transcript/elevenlabs': { provider: 'elevenlabs', kind: 'transcript', engine: 'scribe_v2', of: 'original-audio',
      path: '/srv/transcripts/bazargan[-short]/{lang}/{c3}/{c3}_{v3}.json',
      byLang: { long: scanByLang('/srv/transcripts/bazargan', '.json'), short: scanByLang('/srv/transcripts/bazargan-short', '.json') } },
    'performance/derived': { provider: 'derived', kind: 'performance', of: 'transcript+audio',
      path: '/srv/transcripts/**/{c3}_{v3}.perf.json', count: (function(){let n=0;const w=(d)=>{for(const f of fs.existsSync(d)?fs.readdirSync(d):[]){const p=path.join(d,f);if(fs.statSync(p).isDirectory())w(p);else if(f.endsWith('.perf.json'))n++;}};w('/srv/transcripts');return n;})() },
    'voice-profile/derived': { provider: 'derived', kind: 'voice-profile', of: 'original-audio',
      path: '/srv/voice-profiles/{long|short}/{c3}/{c3}_{v3}.voice.json',
      count: (function(){let n=0;const w=(d)=>{for(const f of fs.existsSync(d)?fs.readdirSync(d):[]){const p=path.join(d,f);if(fs.statSync(p).isDirectory())w(p);else if(f.endsWith('.voice.json'))n++;}};w('/srv/voice-profiles');return n;})() },
  },
};

const size = (b) => b > 1e9 ? (b/1e9).toFixed(1)+'G' : b > 1e6 ? (b/1e6).toFixed(0)+'M' : (b/1e3).toFixed(0)+'K';
M.summary = {};
for (const [k, a] of Object.entries(M.assets)) {
  if (a.coverage) M.summary[k] = `${a.coverage.surahs} surahs / ${a.coverage.ayahs} ayahs (${size(a.coverage.bytes)})`;
  else if (a.byLang) { const langs = Object.keys(a.byLang.long ? {...a.byLang.long, ...a.byLang.short} : a.byLang); M.summary[k] = `langs: ${langs.join(',') || 'none'}`; }
  else if (typeof a.count === 'number') M.summary[k] = `${a.count} files`;
}

fs.writeFileSync('/srv/manifest.json', JSON.stringify(M, null, 2));
console.log(JSON.stringify(M.summary, null, 2));
