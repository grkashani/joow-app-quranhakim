// Layout — the single source of truth for how a clip maps to a path + a public
// URL + its sidecar names + a canonical clipKey. EXACT extractions of the pure
// helpers currently inlined in server.mjs (pad3, fill, cachePath, ttsPath,
// ttsSegPath, meaningPath, localAudioPath, the `rel` URL builders, the
// .words.json/.gen.json sidecar naming). Pinned by layout.test.mjs against the
// live shapes.
//
// Why this exists (Phase 1b): the versioned ArtifactStore keys clips by a
// content hash, but the LIVE system stores one flat file per clip and serves it
// by a fixed URL. To wire the new store WITHOUT mass-regenerating 20k paid clips,
// the bridge must (a) know the legacy path for any clip (dual-read old→new) and
// (b) keep emitting the exact same public URL. Both come from here, so server.mjs
// and the bridge can't drift. NOTHING here does I/O — pure string math, so it's
// safe to extract + test ahead of the (review-gated) server.mjs split.
import path from 'node:path'

export const pad3 = (n) => String(n).padStart(3, '0')

// parseClipKey — the INVERSE of describe().clipKey. A clipKey encodes everything
// needed to reconstruct its descriptor, so the bridge can map clipKey -> legacy
// path without threading the descriptor through the store interface. Pure string
// math. Invariant (pinned by the test): describe(parseClipKey(k)).clipKey === k.
export function parseClipKey(clipKey) {
  const p = String(clipKey).split('/')
  const sa = (seg) => { const [s, a] = seg.split('_'); return { s: parseInt(s, 10), a: parseInt(a, 10) } }
  switch (p[0]) {
    case 'stt':
      // stt/<id>/<lang>/<SSS_AAA>
      return { kind: 'stt', id: p[1], lang: p[2], ...sa(p[3]) }
    case 'tafsir': {
      // tafsir/<id>/<lang>/<SSS_AAA>[/seg<N>]
      const m = p[4] && /^seg(\d+)$/.exec(p[4])
      return m
        ? { kind: 'tafsir-seg', id: p[1], lang: p[2], ...sa(p[3]), seg: Number(m[1]) }
        : { kind: 'tafsir', id: p[1], lang: p[2], ...sa(p[3]) }
    }
    case 'meaning':
      // meaning/<lang>/<SSS_AAA>[/noann]
      return { kind: 'meaning', lang: p[1], ...sa(p[2]), ann: p[3] !== 'noann' }
    default:
      throw new Error(`parseClipKey: unrecognised clipKey '${clipKey}'`)
  }
}

// server.mjs `fill` — expands a tafsir.audio.pattern placeholder set.
export const fill = (pat, s, a) =>
  pat.replaceAll('{c3}', pad3(s)).replaceAll('{v3}', pad3(a)).replaceAll('{c}', String(s)).replaceAll('{v}', String(a))

// The kind → (dir, urlPrefix) table. urlPrefix mirrors nginx: it is always the
// dir's basename with a leading slash (/srv/tafsir-tts → /tafsir-tts), except
// transcripts, whose dir /srv/transcripts is served at /transcripts.
const DEFAULT_DIRS = {
  SRV: process.env.SRV_ROOT || '/srv',
  TRANSCRIPTS: process.env.TRANSCRIPTS_DIR || '/srv/transcripts',
  TTS_DIR: process.env.TTS_DIR || '/srv/tafsir-tts',
  MEANING_DIR: process.env.MEANING_DIR || '/srv/meaning-tts',
}

export function createLayout(dirs = {}) {
  const D = { ...DEFAULT_DIRS, ...dirs }
  const urlPrefix = (dir) => '/' + path.basename(dir)

  // ---- Legacy absolute paths (EXACT copies of the server.mjs builders) ----
  const transcriptPath = (id, lang, s, a) => path.join(D.TRANSCRIPTS, id, lang, pad3(s), `${pad3(s)}_${pad3(a)}.json`)
  const tafsirPath = (id, lang, s, a) => path.join(D.TTS_DIR, id, lang, pad3(s), `${pad3(s)}_${pad3(a)}.mp3`)
  const tafsirSegPath = (id, lang, s, a, idx) => path.join(D.TTS_DIR, id, lang, pad3(s), `${pad3(s)}_${pad3(a)}.seg${idx}.mp3`)
  const meaningPath = (lang, s, a, ann) => path.join(D.MEANING_DIR, lang, pad3(s), `${pad3(s)}_${pad3(a)}${ann ? '' : '.noann'}.mp3`)
  // Human source recitation, from a tafsir's own audio.pattern (e.g. Bazargan).
  const localAudioPath = (tafsir, s, a) => path.join(D.SRV, fill(tafsir.audio.pattern, s, a).replace(/^\//, ''))

  // ---- Public URLs (EXACT copies of the `rel` builders) ----
  const transcriptUrl = (id, lang, s, a) => `${urlPrefix(D.TRANSCRIPTS)}/${id}/${lang}/${pad3(s)}/${pad3(s)}_${pad3(a)}.json`
  const tafsirUrl = (id, lang, s, a) => `${urlPrefix(D.TTS_DIR)}/${id}/${lang}/${pad3(s)}/${pad3(s)}_${pad3(a)}.mp3`
  const tafsirSegUrl = (id, lang, s, a, idx) => `${urlPrefix(D.TTS_DIR)}/${id}/${lang}/${pad3(s)}/${pad3(s)}_${pad3(a)}.seg${idx}.mp3`
  const meaningUrl = (lang, s, a, ann) => `${urlPrefix(D.MEANING_DIR)}/${lang}/${pad3(s)}/${pad3(s)}_${pad3(a)}${ann ? '' : '.noann'}.mp3`

  // ---- Sidecar naming (EXACT: server.mjs writes both next to every .mp3) ----
  const wordsSidecar = (abs) => abs.replace(/\.mp3$/, '.words.json')
  const genSidecar = (abs) => abs.replace(/\.mp3$/, '.gen.json')

  // ---- Clip descriptor → the four facts the store/bridge needs ----
  // A descriptor is { kind, id?, lang, s, a, seg?, ann? }.
  //   kind: 'stt' | 'tafsir' | 'tafsir-seg' | 'meaning'
  //   id:   tafsir id (required for stt/tafsir/tafsir-seg; absent for meaning)
  // Returns { clipKey, legacyPath, url, words, gen }.
  //   clipKey    — canonical, stable, filesystem-safe subdir key the versioned
  //                ArtifactStore lives under (independent of the flat layout).
  //   legacyPath — the CURRENT flat file, so the bridge can dual-read old→new.
  //   words/gen  — legacy sidecar paths (null for stt, which has no .mp3).
  function describe(d) {
    const { kind, id, lang, s, a, seg, ann } = d
    let clipKey, legacyPath, url
    switch (kind) {
      case 'stt':
        clipKey = `stt/${id}/${lang}/${pad3(s)}_${pad3(a)}`
        legacyPath = transcriptPath(id, lang, s, a)
        url = transcriptUrl(id, lang, s, a)
        return { clipKey, legacyPath, url, words: null, gen: null }
      case 'tafsir':
        clipKey = `tafsir/${id}/${lang}/${pad3(s)}_${pad3(a)}`
        legacyPath = tafsirPath(id, lang, s, a)
        url = tafsirUrl(id, lang, s, a)
        break
      case 'tafsir-seg':
        clipKey = `tafsir/${id}/${lang}/${pad3(s)}_${pad3(a)}/seg${seg}`
        legacyPath = tafsirSegPath(id, lang, s, a, seg)
        url = tafsirSegUrl(id, lang, s, a, seg)
        break
      case 'meaning':
        clipKey = `meaning/${lang}/${pad3(s)}_${pad3(a)}${ann ? '' : '/noann'}`
        legacyPath = meaningPath(lang, s, a, ann)
        url = meaningUrl(lang, s, a, ann)
        break
      default:
        throw new Error(`describe: unknown kind '${kind}'`)
    }
    return { clipKey, legacyPath, url, words: wordsSidecar(legacyPath), gen: genSidecar(legacyPath) }
  }

  return {
    pad3, fill, dirs: D,
    transcriptPath, tafsirPath, tafsirSegPath, meaningPath, localAudioPath,
    transcriptUrl, tafsirUrl, tafsirSegUrl, meaningUrl,
    wordsSidecar, genSidecar,
    describe, parseClipKey,
  }
}
