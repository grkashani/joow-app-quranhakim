#!/usr/bin/env python3
# Knowledge-graph transcription consumer.
#
# User voice/video comments are stored under /srv/contributions and each enqueues
# a job in _transcribe/. This drains that queue: transcribe the media (faster-
# whisper, auto language) and fill the `transcript` field of the matching KG
# corpus record, so every spoken contribution becomes retrievable text for a
# future QuranGPT. Idempotent + resumable: a processed job is removed; a corpus
# record already transcribed is skipped. Exits fast when the queue is empty (so a
# frequent cron costs nothing until there is work).
#
#   /srv/prosody-venv/bin/python /srv/contrib-transcribe.py
import os, sys, json, glob, subprocess, tempfile, time

CONTRIB = os.environ.get("CONTRIB_DIR", "/srv/contributions")
QUEUE = os.path.join(CONTRIB, "_transcribe")
CORPUS = os.path.join(CONTRIB, "_corpus")
MODEL = os.environ.get("CONTRIB_WHISPER_MODEL", "small")  # small = fast; medium for quality

jobs = sorted(glob.glob(os.path.join(QUEUE, "*.job")))
if not jobs:
    sys.exit(0)  # nothing to do — don't even import the model

from faster_whisper import WhisperModel
model = WhisperModel(MODEL, device="cpu", compute_type="int8", download_root="/srv/whisper-models")

def corpus_path(surah, cid):
    return os.path.join(CORPUS, f"{int(surah):03d}", f"{cid}.json")

def audio_of(media_abs):
    # images/pdf have no audio; audio plays directly; video -> extract wav.
    ext = media_abs.rsplit(".", 1)[-1].lower()
    if ext in ("mp4", "webm", "mov", "ogv"):
        wav = tempfile.mktemp(suffix=".wav")
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", media_abs,
                        "-ar", "16000", "-ac", "1", wav], check=True)
        return wav, True
    return media_abs, False

done = 0
for j in jobs:
    try:
        job = json.load(open(j))
        cid, surah, rel = job.get("id"), job.get("surah"), job.get("file")
        media_abs = os.path.join(CONTRIB, rel) if rel else None
        cp = corpus_path(surah, cid)
        if not media_abs or not os.path.exists(media_abs) or not os.path.exists(cp):
            os.remove(j); continue
        rec = json.load(open(cp))
        if rec.get("transcript"):  # already transcribed
            os.remove(j); continue
        wav, tmp = audio_of(media_abs)
        segs, info = model.transcribe(wav, beam_size=2, vad_filter=True)
        text = " ".join(s.text.strip() for s in segs).strip()
        if tmp:
            try: os.remove(wav)
            except OSError: pass
        rec["transcript"] = text
        rec["transcriptLang"] = getattr(info, "language", None)
        rec["transcribedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        rec["transcriptModel"] = f"faster-whisper/{MODEL}"
        json.dump(rec, open(cp, "w"), ensure_ascii=False)
        os.remove(j)
        done += 1
        print(f"[kg] {cid} s{surah}: {text[:60]!r}")
    except Exception as e:
        print(f"[kg] job {j} failed: {e}", file=sys.stderr)
        # leave the job for the next run (resumable); don't crash the batch.
print(f"[kg] transcribed {done}/{len(jobs)}")
