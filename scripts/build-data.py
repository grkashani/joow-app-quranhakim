#!/usr/bin/env python3
"""Convert the extracted Quran Hakim corpus into clean JSON for the joowquran web app.

Sources (extracted from the app APK, assets/dta/):
  qrnChp.xml   surah metadata: <num> <fa> <en> <ttlVer>
  qrnFul.txt   Arabic, one ayah per line (leading "0" header)
  qrnFaRaw.txt Persian (Bazargan) translation, one ayah per line
  qrnEnRaw.txt English (Bazargan) translation, one ayah per line

Output (into web/public/data/):
  surahs.json          [{num, nameFa, nameEn, ttlVer}]
  surah/<num>.json     {num, nameFa, nameEn, ayahs:[{n, ar, fa, en}]}
"""
import io, json, os, re, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else None
OUT = sys.argv[2] if len(sys.argv) > 2 else None
if not SRC or not OUT:
    sys.exit("usage: build-data.py <corpus_dta_dir> <out_data_dir>")


def read_ayahs(name, strip_header):
    with io.open(os.path.join(SRC, name), encoding="utf-8-sig") as f:
        lines = [l.rstrip("\n").rstrip("\r") for l in f]
    while lines and lines[-1] == "":
        lines.pop()
    if strip_header and lines and lines[0].strip() == "0":
        lines = lines[1:]
    return lines


ar = read_ayahs("qrnFul.txt", True)
fa = read_ayahs("qrnFaRaw.txt", False)
en = read_ayahs("qrnEnRaw.txt", False)

xml = io.open(os.path.join(SRC, "qrnChp.xml"), encoding="utf-8-sig").read()
chapters = []
for m in re.finditer(r"<chp>(.*?)</chp>", xml, re.S):
    blk = m.group(1)
    chapters.append({
        "num": int(re.search(r"<num>(\d+)</num>", blk).group(1)),
        "nameFa": re.search(r"<fa>(.*?)</fa>", blk).group(1).strip(),
        "nameEn": re.search(r"<en>(.*?)</en>", blk).group(1).strip(),
        "ttlVer": int(re.search(r"<ttlVer>(\d+)</ttlVer>", blk).group(1)),
    })

total = sum(c["ttlVer"] for c in chapters)
assert len(chapters) == 114, f"expected 114 surahs, got {len(chapters)}"
for label, arr in (("ar", ar), ("fa", fa), ("en", en)):
    assert len(arr) == total, f"{label}: {len(arr)} ayahs, expected {total}"

os.makedirs(os.path.join(OUT, "surah"), exist_ok=True)
index = []
cur = 0
for c in chapters:
    n = c["ttlVer"]
    ayahs = [
        {"n": i + 1, "ar": ar[cur + i].strip(), "fa": fa[cur + i].strip(), "en": en[cur + i].strip()}
        for i in range(n)
    ]
    cur += n
    with io.open(os.path.join(OUT, "surah", f"{c['num']}.json"), "w", encoding="utf-8") as f:
        json.dump({"num": c["num"], "nameFa": c["nameFa"], "nameEn": c["nameEn"], "ayahs": ayahs},
                  f, ensure_ascii=False, separators=(",", ":"))
    index.append({"num": c["num"], "nameFa": c["nameFa"], "nameEn": c["nameEn"], "ttlVer": n})

with io.open(os.path.join(OUT, "surahs.json"), "w", encoding="utf-8") as f:
    json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

print(f"OK: 114 surahs, {total} ayahs -> {OUT}")
