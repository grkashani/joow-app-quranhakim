#!/usr/bin/env python3
# Layer 3 — acoustic tone/stress. For one ayah: decode the mp3, run Praat pitch
# (F0) + intensity (loudness) analysis, and merge per-word values into its
# .perf.json (fields f0, f0st, slope, energy). This is the real "tone" — the
# pitch contour and loudness of Bazargan's actual voice — that timing can't give.
#
#   pitch_energy.py <audio.mp3> <perf.json>
#
# f0     = median pitch over the word, Hz (null if unvoiced)
# f0st   = semitones relative to the clip's median F0 (portable across clips)
# slope  = end-minus-start pitch within the word, semitones (+ rising / - falling)
# energy = mean loudness over the word, dB relative to the clip's median (stress)
import sys, os, json, math, subprocess, tempfile
import numpy as np
import parselmouth

def die(msg):
    sys.stderr.write(msg + "\n"); sys.exit(1)

mp3, perf_path = sys.argv[1], sys.argv[2]
if not os.path.exists(mp3) or not os.path.exists(perf_path):
    die("missing input")

with open(perf_path) as f:
    perf = json.load(f)

# mp3 -> mono 16k wav (Praat needs PCM)
wav = tempfile.mktemp(suffix=".wav")
try:
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", mp3,
                    "-ar", "16000", "-ac", "1", wav], check=True)
    snd = parselmouth.Sound(wav)
    pitch = snd.to_pitch(time_step=0.01, pitch_floor=70, pitch_ceiling=350)  # adult male speech
    inten = snd.to_intensity(minimum_pitch=70, time_step=0.01)
finally:
    if os.path.exists(wav): os.remove(wav)

pt = pitch.xs()
pf = pitch.selected_array['frequency']            # 0.0 where unvoiced
it = inten.xs()
iv = inten.values[0]

voiced = pf[pf > 0]
med_f0 = float(np.median(voiced)) if voiced.size else 0.0
med_db = float(np.median(iv)) if iv.size else 0.0

def st(hz):                                        # Hz -> semitones vs clip median
    return round(12.0 * math.log2(hz / med_f0), 2) if (hz and med_f0) else None

def window(times, vals, s, e, voiced_only=False):
    m = (times >= s) & (times <= e)
    v = vals[m]
    if voiced_only: v = v[v > 0]
    return v

for seg in perf.get("segments", []):
    for w in seg.get("words", []):
        if "w" not in w:
            continue
        s, e = w["s"], w["e"]
        fw = window(pt, pf, s, e, voiced_only=True)
        if fw.size:
            f0 = float(np.median(fw))
            w["f0"] = round(f0, 1)
            w["f0st"] = st(f0)
            # slope: first vs last quarter of the word's voiced pitch, semitones
            if fw.size >= 4 and med_f0:
                a = float(np.median(fw[:max(1, fw.size // 4)]))
                b = float(np.median(fw[-max(1, fw.size // 4):]))
                w["slope"] = round(12.0 * math.log2(b / a), 2) if a > 0 and b > 0 else 0.0
            else:
                w["slope"] = 0.0
        ew = window(it, iv, s, e)
        if ew.size:
            w["energy"] = round(float(np.mean(ew)) - med_db, 1)   # dB vs clip median

perf.setdefault("layers", {})["pitch"] = True
perf["speaker"]["medF0"] = round(med_f0, 1)
perf["speaker"]["medDb"] = round(med_db, 1)

with open(perf_path, "w") as f:
    json.dump(perf, f, ensure_ascii=False)
print("ok " + os.path.basename(perf_path))
