# JoowQuran

React (Vite) mini-app for the JooW platform — a redesign of the **Quran Hakim** app
(`air.org.ePayam.QuranKarimAuidoTranslation`, an Adobe AIR app) with the Bazargan
translation/tafsir corpus and verse-by-verse recitation.

## Structure

```
joowquran/
  joow.app.yaml          platform manifest (surface: web, apps.joow.ir/joowquran/web/)
  joow-app-theme.css     shared JooW theme (accent: green #15803d, class .jq-app)
  scripts/build-data.py  corpus → JSON converter (re-runnable)
  web/                   React 18 + Vite (JSX), react-router
    public/data/         generated: surahs.json + surah/<1..114>.json
    src/pages/Home.jsx   surah list + search
    src/pages/Reader.jsx ayah reader + recitation audio
    src/lib/data.js      data loaders + everyayah audio URLs
```

## Data provenance

- **Text** — extracted from the Quran Hakim APK (`assets/dta/`): Arabic (`qrnFul.txt`),
  Persian and English Bazargan translations (`qrnFaRaw.txt`, `qrnEnRaw.txt`), surah
  metadata (`qrnChp.xml`). 114 surahs / 6236 ayahs, validated by `build-data.py`.
  The Quran's Arabic text is public domain; the Bazargan translations are © their author.
- **Recitation audio** — streamed from [everyayah.com](https://everyayah.com) (public
  verse-by-verse repository), pattern `data/<reciter>/<SSS><AAA>.mp3`. Reciters are
  copyrighted recordings; streamed, not redistributed.

## Not yet ported (from the original app)

- Tafsir **lecture** audio + English translation audio (`quranhakimapp.com/ssn/`,
  `divaryab.com/pym/ssn/`) — exact per-session URLs need a network capture to enumerate.
- Word-by-word view, root/lemma browser, keyword search (source data already extracted:
  `qrnWrd.txt`, `qrnRut.txt`, `keyVer.txt`), and the per-surah Bazargan tafsir prose.

## Develop

```
cd web
npm install
npm run dev      # http://localhost:3308
npm run build    # -> web/dist  (base /joowquran/web/)
```

Regenerate data: `python3 scripts/build-data.py <extracted>/assets/dta web/public/data`
