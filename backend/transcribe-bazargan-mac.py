#!/usr/bin/env python3
# FREE local transcription of the Bazargan recordings on YOUR Mac (Apple Silicon).
# Produces the exact same format the server expects (transcript JSON with word
# timings + a karaoke .words.json sidecar), so everything downstream — karaoke,
# the performance format, translations, voice data — just works. No ElevenLabs.
#
# WHY the Mac: large-v3 gives strong Persian; on Apple Silicon it runs several ×
# realtime. (The server proved too weak: 0.6x realtime + the medium model garbles
# Persian.)
#
# ── one-time setup ────────────────────────────────────────────────────────────
#   pip install faster-whisper        # cross-platform; or: pip install mlx-whisper (fastest on M-series)
#   # pull the audio from the server (6 GB) once:
#   mkdir -p ~/bazargan/audio && rsync -az root@91.107.131.70:/srv/tafsir/ssn/       ~/bazargan/audio/long/
#   rsync -az root@91.107.131.70:/srv/tafsir-short/                                   ~/bazargan/audio/short/
#
# ── run ───────────────────────────────────────────────────────────────────────
#   python3 transcribe_bazargan_mac.py short        # then: ... long
#   # push results back to the server:
#   rsync -az ~/bazargan/out/transcripts/  root@91.107.131.70:/srv/transcripts/
#   rsync -az ~/bazargan/out/short-sidecars/  root@91.107.131.70:/srv/tafsir-short/
#   rsync -az ~/bazargan/out/long-sidecars/   root@91.107.131.70:/srv/tafsir/ssn/
#   # then on the server:  node /srv/perf_build.mjs all && node /srv/pitch_driver.mjs
import sys, os, json, glob, time
from faster_whisper import WhisperModel

KIND = sys.argv[1] if len(sys.argv) > 1 else "short"
AUDIO = os.path.expanduser(f"~/bazargan/audio/{KIND}")
OUT = os.path.expanduser("~/bazargan/out")
# transcript dir mirrors the server: /srv/transcripts/<id>/fa/<c3>/<c3>_<v3>.json
TID = "bazargan-short" if KIND == "short" else "bazargan"
TR_DIR = os.path.join(OUT, "transcripts", TID, "fa")
SIDE_DIR = os.path.join(OUT, f"{KIND}-sidecars")   # mirrors /srv/tafsir-short or /srv/tafsir/ssn

# large-v3 for Persian quality. compute_type: "int8" (CPU) is safe everywhere;
# on Apple Silicon try device="auto". mlx-whisper is faster if you prefer it.
model = WhisperModel("large-v3", device="auto", compute_type="int8", download_root=os.path.expanduser("~/bazargan/models"))

files = sorted(glob.glob(os.path.join(AUDIO, "**", "*.mp3"), recursive=True))
print(f"{len(files)} files, kind={KIND}")
done = 0; t0 = time.time()
for mp3 in files:
    base = os.path.basename(mp3)[:-4]            # e.g. 001_001
    c3 = base[:3]
    trp = os.path.join(TR_DIR, c3, base + ".json")
    if os.path.exists(trp):
        continue
    segs, info = model.transcribe(mp3, language="fa", word_timestamps=True, beam_size=2, vad_filter=True)
    segs = list(segs)
    words = [{"t": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2)}
             for s in segs for w in (s.words or []) if w.word.strip()]
    text = " ".join(s.text.strip() for s in segs).strip()
    seglist = [{"s": round(s.start, 2), "e": round(s.end, 2), "text": s.text.strip()} for s in segs]
    os.makedirs(os.path.dirname(trp), exist_ok=True)
    json.dump({"text": text, "lang": "fa", "source": "whisper-large-v3",
               "model": "large-v3", "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "words": words, "segments": seglist},
              open(trp, "w"), ensure_ascii=False)
    # karaoke sidecar next to where the audio lives on the server
    kw = [{"w": w["t"], "s": w["s"], "e": w["e"]} for w in words]
    dur = max((w["e"] for w in kw), default=0)
    sp = os.path.join(SIDE_DIR, c3, base + ".words.json")
    os.makedirs(os.path.dirname(sp), exist_ok=True)
    json.dump({"words": kw, "dur": dur, "text": text, "source": "whisper-large-v3"}, open(sp, "w"), ensure_ascii=False)
    done += 1
    if done % 20 == 0:
        el = time.time() - t0
        print(f"[{done}] {el/done:.1f}s/file  ~{(len(files)-done)*el/done/3600:.1f}h left")
print(f"done {done} files in {(time.time()-t0)/60:.0f} min")
