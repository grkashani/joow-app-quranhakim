// Convert existing Persian STT transcripts of the Bazargan recordings into
// karaoke .words.json sidecars, co-located next to the human audio so the reader
// picks them up (it derives the sidecar URL from the mp3 URL). Idempotent.
//
//   transcript  /srv/transcripts/bazargan/fa/<c3>/<c3>_<v3>.json   (words:[{t,s,e}])
//   -> sidecar  /srv/tafsir/ssn/<c3>/<c3>_<v3>.words.json          (words:[{w,s,e}])
//   transcript  /srv/transcripts/bazargan-short/fa/<c3>/...        -> /srv/tafsir-short/...
import fs from 'node:fs';
import path from 'node:path';

const JOBS = [
  { src: '/srv/transcripts/bazargan/fa', dst: '/srv/tafsir/ssn' },
  { src: '/srv/transcripts/bazargan-short/fa', dst: '/srv/tafsir-short' },
];

const round3 = (x) => Math.round(x * 1000) / 1000;
let written = 0, noWords = 0, missingAudio = 0, surahs = new Set();

for (const { src, dst } of JOBS) {
  if (!fs.existsSync(src)) { console.log('[skip] no src', src); continue; }
  for (const c3 of fs.readdirSync(src).sort()) {
    const cdir = path.join(src, c3);
    if (!fs.statSync(cdir).isDirectory()) continue;
    for (const f of fs.readdirSync(cdir)) {
      if (!f.endsWith('.json')) continue;
      const base = f.replace(/\.json$/, '');            // e.g. 001_001
      const audio = path.join(dst, c3, base + '.mp3');
      if (!fs.existsSync(audio)) { missingAudio++; continue; }
      let tr;
      try { tr = JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8')); } catch { continue; }
      const words = (Array.isArray(tr.words) ? tr.words : [])
        // drop audio-event tokens (ev) so only spoken words are highlighted
        .filter((w) => w && !w.ev && typeof w.t === 'string' && w.t.trim() &&
                       typeof w.s === 'number' && typeof w.e === 'number' && w.e >= w.s)
        .map((w) => ({ w: w.t, s: round3(w.s), e: round3(w.e) }));
      if (!words.length) { noWords++; continue; }
      const dur = words.reduce((m, w) => Math.max(m, w.e), 0);
      const out = { words, dur, text: typeof tr.text === 'string' ? tr.text : '', source: 'bazargan-stt' };
      fs.writeFileSync(path.join(dst, c3, base + '.words.json'), JSON.stringify(out));
      written++; surahs.add(dst + '/' + c3);
    }
  }
}
console.log(JSON.stringify({ written, noWords, missingAudio, surahDirs: surahs.size }));
