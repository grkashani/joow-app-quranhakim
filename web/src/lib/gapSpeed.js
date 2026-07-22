// Gap-based playback speed ("silence editing") + a whisper of rate.
//
// Changing <audio>.playbackRate aggressively time-stretches the SPEECH itself —
// the voice's tone and rhythm audibly change, which we must never do to a
// reciter's or Bazargan's delivery. But from the karaoke sidecars we know where
// every word starts and ends — so we know where the SILENCES are. Speed is
// therefore built from two ingredients:
//
//   1. silence editing (the main effect)
//        faster -> while playing inside a known gap, seek ahead over most of it
//        slower -> just before a gap ends, seek back INTO the silence once, so
//                  the pause lasts longer (replayed silence is inaudible)
//   2. a ≤10% pitch-preserved rate nudge on the speech itself — small enough to
//        be imperceptible in tone, and it covers clips that have little silence
//        (owner-approved: "10% does not [change the] tone of voice")
//
// A per-clip BUDGET ties them together: knowing total speech vs total silence,
// we solve for how much each gap must shrink/grow so that speech-at-rate-r plus
// edited gaps lands as close as possible to the labeled speed. The audio
// timeline itself never changes, so karaoke word-timings stay exact.
// Both operations are plain seeks driven from the reader's existing rAF tick —
// no timers, no pause/resume state machine.

// An inter-word interval must be at least this long to count as a "gap"
// (anything shorter is articulation space inside continuous speech).
export const MIN_GAP = 0.35
// Never trim a kept gap below this — speech needs SOME breath between phrases.
export const MIN_KEPT = 0.18
// Keep at least this fraction of every pause so his phrasing rhythm survives
// even when the budget says "trim everything".
const KEEP_FLOOR_FRAC = 0.12
// Cap how much extra silence a single pause may gain in slow mode (sanity).
const MAX_EXTRA = 2.0
// When trimming, land this far BEFORE the next word's marked start. Word-timing
// starts run late on soft onsets (nasals م/ن, unaspirated stops ramp up quietly),
// so too small a margin lands inside the word and clips its onset. This pre-roll
// keeps the full onset audible (it doubles as the research-backed "protect a
// minimum boundary pause even at max speed").
const ONSET_GUARD = 0.14
// Slow mode replays silence by seeking BACK into a gap. Word-timing ENDS are
// marked early (the aligner drops trailing decay/breath), so the previous word's
// real sound spills past its marked end — seeking too close to the gap start
// replays a sliver of that voice ("a small voice from the previous sound"). Stay
// this far past the gap start so only PURE silence is ever replayed.
const TAIL_GUARD = 0.16

// The speech-rate nudge per labeled speed: at most ±10%.
// Three steps only: slow (0.75) / normal (1) / fast (1.5).
const SPEECH_RATE = { 0.75: 0.9, 1: 1, 1.5: 1.1 }
export function speechRate(S) { return SPEECH_RATE[S] ?? 1 }

// words: [{ w, s, e }] (seconds) from a .words.json sidecar; dur: clip length.
// Returns ordered, non-overlapping silence windows [{ s, e }].
export function buildGaps(words, dur) {
  const gaps = []
  if (!Array.isArray(words) || words.length === 0) return gaps
  if (words[0].s >= MIN_GAP) gaps.push({ s: 0.03, e: words[0].s })
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i].e, b = words[i + 1].s
    if (isFinite(a) && isFinite(b) && b - a >= MIN_GAP) gaps.push({ s: a, e: b })
  }
  const last = words[words.length - 1].e
  if (isFinite(dur) && dur - last >= MIN_GAP) gaps.push({ s: last, e: dur - 0.03 })
  return gaps
}

// Per-clip budget: total known silence (G) and speech (Sp) in media seconds.
export function gapMeta(gaps, dur) {
  const G = gaps.reduce((a, g) => a + (g.e - g.s), 0)
  const Sp = isFinite(dur) && dur > G ? dur - G : 0
  return { G, Sp }
}

// The gap scale factor that makes (speech at rate r) + (gaps × factor) take
// (Sp+G)/S wall seconds. <1 trims, >1 stretches. Falls back to 1/S when the
// clip has no meaningful silence budget to solve against.
function gapFactor(meta, S, r) {
  if (!meta || meta.G < 0.2) return 1 / S
  const f = (r * (meta.Sp + meta.G) / S - meta.Sp) / meta.G
  return isFinite(f) ? f : 1 / S
}

// One frame of gap-speed. `sync` carries { gaps, gapMeta, stretched:Set,
// pendingSeeks:number[] }. Returns the new currentTime when it performed a seek,
// else null. Each engine seek records its TARGET in pendingSeeks so onSeeked can
// attribute the resulting `seeked` event by position (not a shared boolean that
// a concurrent user-scrub could steal — the double-stretch race).
export function gapTick(el, sync, S) {
  const gaps = sync.gaps
  if (!el || el.paused || !gaps || gaps.length === 0 || !S || S === 1) return null
  if (el.seeking) return null     // a seek is settling — don't stack another
  const t = el.currentTime
  const r = el.playbackRate || 1
  const f = gapFactor(sync.gapMeta, S, r)
  const doSeek = (to) => {
    sync.pendingSeeks.push(to)
    if (sync.pendingSeeks.length > 6) sync.pendingSeeks.shift() // backstop if a seeked never fires
    el.currentTime = to
    return to
  }
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i]
    if (t < g.s) break            // gaps are ordered; we're before the next one
    if (t >= g.e) continue
    const gapDur = g.e - g.s
    if (S > 1) {
      // Trim: keep gapDur×f of the silence (never below the phrasing floor),
      // then hop to just BEFORE the next word's onset (ONSET_GUARD pre-roll, so
      // a late-marked soft onset like م isn't clipped). Only seek if it still
      // moves us meaningfully forward — else leave this short gap alone.
      const keep = Math.max(MIN_KEPT, gapDur * KEEP_FLOOR_FRAC, gapDur * f)
      const to = g.e - ONSET_GUARD
      if (t >= g.s + keep && to - t > 0.04) return doSeek(to)
    } else if (!sync.stretched.has(i) && t >= g.e - 0.12) {
      // Stretch: approaching the gap's end, replay part of the silence ONCE so
      // the pause lasts ~gapDur×f in total. Marked so a pass stretches once. The
      // back-seek never crosses TAIL_GUARD, so it lands in PURE silence (never
      // the previous word's trailing decay). Skip if there's no clean silence.
      sync.stretched.add(i)
      const extra = Math.min(MAX_EXTRA, gapDur * Math.max(0, f - 1))
      const to = Math.max(g.s + TAIL_GUARD, t - extra)
      if (t - to > 0.06) return doSeek(to)
    }
    break
  }
  return null
}
