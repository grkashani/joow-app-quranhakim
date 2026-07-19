// From the per-ayah voice profiles, build (1) Bazargan's speaker FINGERPRINT —
// the aggregate acoustic signature that defines his voice — and (2) a curated
// REFERENCE SET: the cleanest, most representative clips to hand a future voice
// clone (ElevenLabs / OpenAI / local). Re-run any time; grows with the sweep.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/srv/voice-profiles';
const profiles = [];
const walk = (d, kind) => { for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) { const p = path.join(d, f);
  if (fs.statSync(p).isDirectory()) walk(p, kind || f);
  else if (f.endsWith('.voice.json')) { try { const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const m = f.match(/^(\d{3})_(\d{3})/); j._kind = kind; j._surah = m ? Number(m[1]) : 0; j._ayah = m ? Number(m[2]) : 0;
    j._mp3 = (kind === 'long' ? '/srv/tafsir/ssn/' : '/srv/tafsir-short/') + f.replace('.voice.json', '.mp3').replace(/^/, m[1] + '/');
    profiles.push(j); } catch {} } } };
['long', 'short'].forEach((k) => walk(path.join(ROOT, k), k));

if (!profiles.length) { console.log('no profiles yet'); process.exit(0); }
const med = (a) => { a = a.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
const collect = (fn) => profiles.map(fn).filter((x) => x != null);

const fingerprint = {
  schema: 'quranhakim/voice-fingerprint@1',
  speaker: 'Abdolali Bazargan', from: `${profiles.length} recordings`,
  totalAudioSec: Math.round(collect((p) => p.dur).reduce((a, b) => a + b, 0)),
  f0: {
    medianHz: med(collect((p) => p.f0?.medianHz)),
    meanHz: med(collect((p) => p.f0?.mean)),
    minHz: Math.min(...collect((p) => p.f0?.min)),
    maxHz: Math.max(...collect((p) => p.f0?.max)),
    typicalRangeSt: med(collect((p) => p.f0?.rangeSt)),
  },
  formants: { F1: med(collect((p) => p.formants?.F1)), F2: med(collect((p) => p.formants?.F2)),
    F3: med(collect((p) => p.formants?.F3)), F4: med(collect((p) => p.formants?.F4)) },
  voiceQuality: { hnrDb: med(collect((p) => p.hnr)), jitter: med(collect((p) => p.jitter)), shimmer: med(collect((p) => p.shimmer)) },
  intensity: { medianDb: med(collect((p) => p.intensity?.median)) },
  voicedFraction: med(collect((p) => p.voicedFrac)),
  note: 'The acoustic identity of his voice — pitch, vocal-tract formants (timbre), and voice quality. Pair with the reference-set clips to clone.',
};

// Reference set: best clone-quality clips, capped ~30 min, spread across surahs
// (max 3 per surah) so the clone hears varied content, not one lecture.
const perSurah = {};
const ranked = profiles.filter((p) => p.cloneScore != null && p.dur >= 3)
  .sort((a, b) => b.cloneScore - a.cloneScore);
const ref = []; let secs = 0;
for (const p of ranked) {
  if (secs >= 1800) break;
  const key = p._kind + ':' + p._surah;
  if ((perSurah[key] || 0) >= 3) continue;
  perSurah[key] = (perSurah[key] || 0) + 1;
  ref.push({ kind: p._kind, surah: p._surah, ayah: p._ayah,
    path: (p._kind === 'long' ? '/srv/tafsir/ssn/' : '/srv/tafsir-short/') + String(p._surah).padStart(3, '0') + '/' + String(p._surah).padStart(3, '0') + '_' + String(p._ayah).padStart(3, '0') + '.mp3',
    dur: p.dur, cloneScore: p.cloneScore, hnr: p.hnr, f0med: p.f0?.medianHz });
  secs += p.dur;
}

fs.writeFileSync(path.join(ROOT, 'bazargan.fingerprint.json'), JSON.stringify(fingerprint, null, 2));
fs.writeFileSync(path.join(ROOT, 'reference-set.json'), JSON.stringify({ schema: 'quranhakim/voice-reference@1',
  purpose: 'Cleanest clips to train/condition a voice clone of Bazargan', totalSec: Math.round(secs), clips: ref }, null, 2));
console.log(JSON.stringify({ profiles: profiles.length, fingerprint, referenceClips: ref.length, referenceMinutes: Math.round(secs / 60) }, null, 2));
