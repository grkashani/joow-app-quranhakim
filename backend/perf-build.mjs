// Build the "performance transcript" — a delivery-annotated script so a future
// multilingual TTS can re-perform Bazargan's phrasing. Layer 1 here (timing
// prosody: pauses, emphasis, pace, segments). Layer 3 (real pitch F0 + loudness)
// is filled by pitch_energy.py, which merges into the same per-word f0/energy
// fields. Output: <transcript>.perf.json next to the transcript.
//
//   node perf_build.mjs <transcript.json>          -> write its .perf.json
//   node perf_build.mjs all                        -> build for every fa transcript
//   node perf_build.mjs <transcript.json> --ssml   -> print SSML to stdout
import fs from 'node:fs';
import path from 'node:path';

const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

export function buildPerf(tr) {
  const W = (tr.words || []).filter((w) => w && typeof w.s === 'number' && typeof w.e === 'number' && (w.t || '').length);
  if (!W.length) return null;
  const spc = W.filter((w) => !w.ev).map((w) => (w.e - w.s) / Math.max((w.t || '').length, 1)).sort((a, b) => a - b);
  const medSPC = spc[Math.floor(spc.length / 2)] || 0.06;
  const durs = W.map((w) => w.e - w.s).sort((a, b) => a - b);
  const medDur = durs[Math.floor(durs.length / 2)] || 0.3;

  const BREAK = /[.؟!?:؛]$/;
  const segs = []; let cur = null;
  for (let i = 0; i < W.length; i++) {
    const w = W[i], prev = W[i - 1];
    const gapBefore = prev ? round2(w.s - prev.e) : 0;
    if (!cur || (prev && (BREAK.test(prev.t) || gapBefore > 0.6))) { cur = { words: [] }; segs.push(cur); }
    cur.words.push({ ...w, gapBefore });
  }
  const emphasisOf = (w, gapBefore, gapAfter) => {
    const expected = w.t.length * medSPC;
    const held = expected > 0 ? (w.e - w.s) / expected : 1;
    const silence = (gapBefore + gapAfter) / 0.8;
    return round2(clamp(0.55 * (held - 1) + 0.45 * silence));
  };
  const out = { ref: tr.ref || null, lang: tr.lang || 'fa', source: tr.source || 'stt',
    layers: { timing: true, pitch: false, events: (tr.words || []).some((w) => w.ev) },
    speaker: { medWordDur: round2(medDur), secPerChar: round2(medSPC), words: W.length },
    segments: [] };
  for (let si = 0; si < segs.length; si++) {
    const ws = segs[si].words;
    const start = ws[0].s, end = ws[ws.length - 1].e;
    const nextStart = segs[si + 1]?.words[0]?.s;
    const pauseAfter = nextStart != null ? round2(nextStart - end) : 0;
    const dur = end - start;
    const wps = ws.filter((w) => !w.ev).length / Math.max(dur, 0.1);
    const pace = wps < 2.1 ? 'slow' : wps > 3.4 ? 'fast' : 'normal';
    const words = ws.map((w, i) => {
      const gapAfter = i < ws.length - 1 ? round2(ws[i + 1].s - w.e) : pauseAfter;
      return w.ev
        ? { event: w.t, s: round2(w.s), e: round2(w.e) }
        : { w: w.t, s: round2(w.s), e: round2(w.e), dur: round2(w.e - w.s),
            pauseBefore: round2(w.gapBefore), pauseAfter: gapAfter,
            emphasis: emphasisOf(w, w.gapBefore, gapAfter), f0: null, f0st: null, slope: null, energy: null };
    });
    out.segments.push({ id: `seg${si + 1}`, text: ws.filter((w) => !w.ev).map((w) => w.t).join(' '),
      start: round2(start), end: round2(end), pauseBefore: round2(ws[0].gapBefore), pauseAfter, pace, wordsPerSec: round2(wps), words });
  }
  return out;
}

export function toSSML(o) {
  const parts = ['<speak>'];
  for (const seg of o.segments) {
    if (seg.pauseBefore > 0.25) parts.push(`  <break time="${seg.pauseBefore}s"/>`);
    const rate = seg.pace === 'slow' ? '90%' : seg.pace === 'fast' ? '110%' : '100%';
    const inner = seg.words.filter((w) => w.w).map((w) => {
      let t = w.w;
      if (w.emphasis >= 0.5) t = `<emphasis level="${w.emphasis >= 0.8 ? 'strong' : 'moderate'}">${t}</emphasis>`;
      if (w.pauseAfter > 0.35) t += `<break time="${w.pauseAfter}s"/>`;
      return t;
    }).join(' ');
    parts.push(`  <prosody rate="${rate}">${inner}</prosody>`);
  }
  parts.push('</speak>');
  return parts.join('\n');
}

// ---- CLI ----
const arg = process.argv[2];
if (arg === 'all') {
  const roots = ['/srv/transcripts/bazargan/fa', '/srv/transcripts/bazargan-short/fa'];
  let built = 0, skip = 0;
  const walk = (d) => { for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.json') && !f.endsWith('.perf.json')) {
    try { const tr = JSON.parse(fs.readFileSync(p, 'utf8')); const perf = buildPerf(tr); if (perf) { fs.writeFileSync(p.replace(/\.json$/, '.perf.json'), JSON.stringify(perf)); built++; } else skip++; } catch { skip++; } } } };
  roots.forEach(walk);
  console.log(JSON.stringify({ built, skip }));
} else if (arg) {
  const tr = JSON.parse(fs.readFileSync(arg, 'utf8'));
  const perf = buildPerf(tr);
  if (process.argv[3] === '--ssml') console.log(toSSML(perf));
  else { fs.writeFileSync(arg.replace(/\.json$/, '.perf.json'), JSON.stringify(perf)); console.log('wrote ' + arg.replace(/\.json$/, '.perf.json') + ` (${perf.segments.length} segments)`); }
} else { console.error('usage: perf_build.mjs <transcript.json|all> [--ssml]'); process.exit(1); }
