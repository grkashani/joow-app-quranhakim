// Run the voice-preservation profiler over every Bazargan recording. Short set
// first (smaller → a usable fingerprint fast), then the long lectures.
// Output: /srv/voice-profiles/<kind>/<c3>/<c3>_<v3>.voice.json. Idempotent.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const PY = '/srv/prosody-venv/bin/python';
const SCRIPT = '/srv/voice_profile.py';
const OUT = '/srv/voice-profiles';
const MAP = [
  { kind: 'short', audioRoot: '/srv/tafsir-short' },
  { kind: 'long', audioRoot: '/srv/tafsir/ssn' },
];
const CONC = Math.max(2, (os.cpus()?.length || 2));

function collect() {
  const items = [];
  for (const { kind, audioRoot } of MAP) {
    for (const c3 of (fs.existsSync(audioRoot) ? fs.readdirSync(audioRoot) : []).filter((d) => /^\d{3}$/.test(d)).sort()) {
      for (const f of fs.readdirSync(path.join(audioRoot, c3))) {
        const m = f.match(/^(\d{3}_\d{3})\.mp3$/);
        if (!m) continue;
        const outp = path.join(OUT, kind, c3, m[1] + '.voice.json');
        if (!fs.existsSync(outp)) items.push({ mp3: path.join(audioRoot, c3, f), outp });
      }
    }
  }
  return items;
}

const run = (mp3, outp) => new Promise((resolve) => {
  fs.mkdirSync(path.dirname(outp), { recursive: true });
  const c = spawn(PY, [SCRIPT, mp3, outp], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve(code === 0 ? 'done' : (console.error(`[fail] ${path.basename(outp)}: ${err.slice(0,120)}`), 'fail')));
  c.on('error', () => resolve('fail'));
});

const items = collect();
console.log(`=== voice profiles: ${items.length} files, concurrency ${CONC} ===`);
let i = 0, done = 0, fail = 0;
const t0 = Date.now();
async function worker() {
  for (;;) { const idx = i++; if (idx >= items.length) return;
    const r = await run(items[idx].mp3, items[idx].outp);
    if (r === 'done') done++; else fail++;
    const n = done + fail;
    if (n % 20 === 0 || n === items.length) {
      const secs = (Date.now()-t0)/1000, rate = n/Math.max(secs,1);
      console.log(`[${n}/${items.length}] done=${done} fail=${fail} | ${rate.toFixed(2)}/s | ~${Math.round((items.length-n)/Math.max(rate,.001)/60)}m`);
    }
  }
}
await Promise.all(Array.from({length: CONC}, worker));
console.log(`=== VOICE DONE done=${done} fail=${fail} ===`);
