// Run the Layer-3 pitch/energy analysis over every performance file, mapping it
// to its source mp3. CPU-bound (Praat), so concurrency = cores. Idempotent:
// skips perf files already marked layers.pitch=true.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const PY = '/srv/prosody-venv/bin/python';
const SCRIPT = '/srv/pitch_energy.py';
const MAP = [
  { perfRoot: '/srv/transcripts/bazargan/fa', audioRoot: '/srv/tafsir/ssn' },
  { perfRoot: '/srv/transcripts/bazargan-short/fa', audioRoot: '/srv/tafsir-short' },
];
const CONC = Math.max(2, (os.cpus()?.length || 4) - 1);

function collect() {
  const items = [];
  for (const { perfRoot, audioRoot } of MAP) {
    const walk = (d) => { for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) { const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.perf.json')) {
        const rel = path.relative(perfRoot, p).replace(/\.perf\.json$/, '.mp3');
        const mp3 = path.join(audioRoot, rel);
        if (fs.existsSync(mp3)) items.push({ perf: p, mp3 });
      } } };
    walk(perfRoot);
  }
  return items;
}

function needsPitch(perf) {
  try { return JSON.parse(fs.readFileSync(perf, 'utf8'))?.layers?.pitch !== true; } catch { return true; }
}

const run = (mp3, perf) => new Promise((resolve) => {
  const c = spawn(PY, [SCRIPT, mp3, perf], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  c.stderr.on('data', (d) => { err += d.toString(); });
  c.on('close', (code) => resolve(code === 0 ? 'done' : (console.error(`[fail] ${path.basename(perf)}: ${err.slice(0, 160)}`), 'fail')));
  c.on('error', (e) => resolve((console.error(`[spawn] ${e.message}`), 'fail')));
});

const all = collect();
const items = all.filter((it) => needsPitch(it.perf));
console.log(`=== pitch/energy: ${items.length} files (of ${all.length}), concurrency ${CONC} ===`);
let i = 0, done = 0, fail = 0;
const t0 = Date.now();
async function worker() {
  for (;;) {
    const idx = i++; if (idx >= items.length) return;
    const r = await run(items[idx].mp3, items[idx].perf);
    if (r === 'done') done++; else fail++;
    const n = done + fail;
    if (n % 20 === 0 || n === items.length) {
      const secs = (Date.now() - t0) / 1000, rate = n / Math.max(secs, 1);
      console.log(`[${n}/${items.length}] done=${done} fail=${fail} | ${rate.toFixed(2)}/s | ~${Math.round((items.length - n) / Math.max(rate, 0.001) / 60)}m`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`=== PITCH DONE done=${done} fail=${fail} ===`);
