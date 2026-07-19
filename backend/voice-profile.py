#!/usr/bin/env python3
# Voice-preservation capture. For one Bazargan recording, extract the acoustic
# signature that a future voice clone (ElevenLabs, OpenAI, or anything) can use
# to reconstruct his voice — the parts of "his voice" a transcript can't hold:
#   pitch identity, vocal-tract formants (timbre), voice quality (HNR/jitter/
#   shimmer), loudness dynamics, and a clone-suitability score for picking the
#   cleanest reference clips.
#
#   voice_profile.py <audio.mp3> <out.voice.json>
import sys, os, json, math, subprocess, tempfile
import numpy as np
import parselmouth
from parselmouth.praat import call

mp3, outp = sys.argv[1], sys.argv[2]
wav = tempfile.mktemp(suffix=".wav")
try:
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", mp3,
                    "-ar", "22050", "-ac", "1", wav], check=True)
    snd = parselmouth.Sound(wav)
    dur = snd.get_total_duration()

    pitch = snd.to_pitch(time_step=0.01, pitch_floor=70, pitch_ceiling=350)
    f0 = pitch.selected_array['frequency']; f0v = f0[f0 > 0]
    inten = snd.to_intensity(minimum_pitch=70, time_step=0.01); iv = inten.values[0]

    def stats(a):
        a = np.asarray(a, float)
        return None if a.size == 0 else dict(
            mean=round(float(np.mean(a)), 1), median=round(float(np.median(a)), 1),
            min=round(float(np.min(a)), 1), max=round(float(np.max(a)), 1),
            sd=round(float(np.std(a)), 1))

    prof = {"dur": round(dur, 2), "voicedFrac": round(float(f0v.size) / max(f0.size, 1), 3)}
    prof["f0"] = stats(f0v) or {}
    if f0v.size:
        med = float(np.median(f0v))
        prof["f0"]["rangeSt"] = round(12 * math.log2(max(f0v) / min(f0v)), 1) if min(f0v) > 0 else None
        prof["f0"]["medianHz"] = round(med, 1)
    prof["intensity"] = stats(iv) or {}

    # Formants F1-F4 = vocal-tract signature (the "colour"/timbre of his voice)
    try:
        fmt = snd.to_formant_burg(time_step=0.01, max_number_of_formants=5, maximum_formant=5000)
        ts = pitch.xs()
        F = {1: [], 2: [], 3: [], 4: []}
        for t, hz in zip(ts, f0):
            if hz > 0:
                for n in F:
                    v = fmt.get_value_at_time(n, t)
                    if v and not math.isnan(v):
                        F[n].append(v)
        prof["formants"] = {f"F{n}": round(float(np.median(v)), 0) for n, v in F.items() if v}
    except Exception:
        prof["formants"] = {}

    # Voice quality — HNR (clarity), jitter (pitch steadiness), shimmer (amplitude steadiness)
    try:
        harm = call(snd, "To Harmonicity (cc)", 0.01, 70, 0.1, 1.0)
        prof["hnr"] = round(call(harm, "Get mean", 0, 0), 2)
    except Exception:
        prof["hnr"] = None
    try:
        pp = call(snd, "To PointProcess (periodic, cc)", 70, 350)
        prof["jitter"] = round(call(pp, "Get jitter (local)", 0, 0, 1e-4, 0.02, 1.3), 5)
        prof["shimmer"] = round(call([snd, pp], "Get shimmer (local)", 0, 0, 1e-4, 0.02, 1.3, 1.6), 5)
    except Exception:
        prof["jitter"] = prof["shimmer"] = None

    # Clone-suitability: clean (high HNR), stable (low jitter/shimmer), well-voiced,
    # useful length. 0..1 — used to pick the best reference clips for cloning.
    hnr = prof.get("hnr") or 0
    jit = prof.get("jitter") or 0.05
    q = 0.0
    q += min(1, max(0, (hnr - 5) / 15)) * 0.45          # HNR 5..20 dB
    q += min(1, max(0, (0.03 - jit) / 0.03)) * 0.25     # low jitter
    q += min(1, prof["voicedFrac"] / 0.7) * 0.2         # mostly voiced
    q += min(1, dur / 8) * 0.1                           # >=8s ideal
    prof["cloneScore"] = round(q, 3)
finally:
    if os.path.exists(wav): os.remove(wav)

with open(outp, "w") as f:
    json.dump(prof, f, ensure_ascii=False)
print("ok " + os.path.basename(outp) + f" clone={prof['cloneScore']} hnr={prof.get('hnr')}")
