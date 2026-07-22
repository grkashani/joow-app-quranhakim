// Characterization tests for the gap-based "silence editing" speed engine.
// These PIN current behavior (the owner-approved model: edit silences, nudge the
// speech rate ≤10%, never time-stretch the voice). If a later refactor changes a
// number here, that's a behavior change to make deliberately — not by accident.
//
// buildGaps / gapMeta / speechRate are pure. gapTick is deterministic given a
// fake <audio> element + a sync bag, so we can drive every branch with no DOM.
import { describe, it, expect } from 'vitest'
import { buildGaps, gapMeta, speechRate, MIN_GAP, MIN_KEPT } from './gapSpeed.js'

// A minimal stand-in for the shared HTMLAudioElement the reader owns.
const fakeEl = (o = {}) => ({
  currentTime: 0, paused: false, seeking: false, playbackRate: 1, ...o,
})
const syncBag = (gaps, meta) => ({
  gaps, gapMeta: meta, stretched: new Set(), pendingSeeks: [],
})

describe('buildGaps', () => {
  it('returns [] for empty / non-array input', () => {
    expect(buildGaps([], 3)).toEqual([])
    expect(buildGaps(null, 3)).toEqual([])
    expect(buildGaps(undefined, 3)).toEqual([])
  })

  it('emits leading, inter-word, and trailing gaps ≥ MIN_GAP', () => {
    const words = [{ w: 'a', s: 0.5, e: 1.0 }, { w: 'b', s: 1.5, e: 2.0 }]
    const gaps = buildGaps(words, 3.0)
    expect(gaps).toEqual([
      { s: 0.03, e: 0.5 },   // leading (words[0].s = 0.5 ≥ 0.35)
      { s: 1.0, e: 1.5 },    // inter-word (1.5 - 1.0 = 0.5 ≥ 0.35)
      { s: 2.0, e: 2.97 },   // trailing (dur - lastEnd = 1.0 ≥ 0.35), minus 0.03
    ])
  })

  it('skips intervals shorter than MIN_GAP (articulation space)', () => {
    // inter-word 1.2-1.0 = 0.2 < 0.35 → not a gap; trailing 2.0-1.6 = 0.4 ≥ 0.35 → gap
    const words = [{ w: 'a', s: 0.5, e: 1.0 }, { w: 'b', s: 1.2, e: 1.6 }]
    expect(buildGaps(words, 2.0)).toEqual([
      { s: 0.03, e: 0.5 },
      { s: 1.6, e: 1.97 },
    ])
  })

  it('emits no leading/trailing gap when the margin is below MIN_GAP', () => {
    const words = [{ w: 'a', s: 0.2, e: 1.0 }] // leading 0.2 < 0.35, trailing 0.1 < 0.35
    expect(buildGaps(words, 1.1)).toEqual([])
  })

  it('ignores non-finite word bounds', () => {
    const words = [{ w: 'a', s: 0.5, e: NaN }, { w: 'b', s: 1.5, e: 2.0 }]
    // inter-word gap needs finite a & b → skipped; leading + trailing still fire
    expect(buildGaps(words, 3.0)).toEqual([
      { s: 0.03, e: 0.5 },
      { s: 2.0, e: 2.97 },
    ])
  })

  it('MIN_GAP boundary is inclusive (exactly 0.35 counts)', () => {
    const words = [{ w: 'a', s: 1.0, e: 1.0 }, { w: 'b', s: 1.35, e: 1.7 }]
    const gaps = buildGaps(words, 1.7)
    expect(gaps).toContainEqual({ s: 1.0, e: 1.35 })
  })
})

describe('gapMeta', () => {
  it('sums silence (G) and derives speech (Sp = dur - G)', () => {
    expect(gapMeta([{ s: 0, e: 1 }, { s: 2, e: 3 }], 5)).toEqual({ G: 2, Sp: 3 })
  })
  it('clamps Sp to 0 when dur ≤ total gap', () => {
    expect(gapMeta([{ s: 0, e: 4 }], 3)).toEqual({ G: 4, Sp: 0 })
  })
  it('empty gaps → all speech', () => {
    expect(gapMeta([], 10)).toEqual({ G: 0, Sp: 10 })
  })
})

describe('speechRate (≤10% pitch-preserved nudge, 3 steps)', () => {
  it('maps the three labeled speeds', () => {
    expect(speechRate(0.75)).toBe(0.9)
    expect(speechRate(1)).toBe(1)
    expect(speechRate(1.5)).toBe(1.1)
  })
  it('falls back to 1 for any other value', () => {
    expect(speechRate(2)).toBe(1)
    expect(speechRate(undefined)).toBe(1)
  })
})

describe('gapTick — no-ops', () => {
  it('does nothing at normal speed (S = 1)', async () => {
    const { gapTick } = await import('./gapSpeed.js')
    const el = fakeEl({ currentTime: 1.5 })
    expect(gapTick(el, syncBag([{ s: 1, e: 2 }], { G: 1, Sp: 2 }), 1)).toBeNull()
    expect(el.currentTime).toBe(1.5) // untouched
  })
  it('does nothing while paused or already seeking', async () => {
    const { gapTick } = await import('./gapSpeed.js')
    expect(gapTick(fakeEl({ paused: true, currentTime: 1.5 }), syncBag([{ s: 1, e: 2 }], { G: 1, Sp: 2 }), 1.5)).toBeNull()
    expect(gapTick(fakeEl({ seeking: true, currentTime: 1.5 }), syncBag([{ s: 1, e: 2 }], { G: 1, Sp: 2 }), 1.5)).toBeNull()
  })
  it('does nothing with no gaps', async () => {
    const { gapTick } = await import('./gapSpeed.js')
    expect(gapTick(fakeEl({ currentTime: 1.5 }), syncBag([], { G: 0, Sp: 3 }), 1.5)).toBeNull()
  })
})

describe('gapTick — FAST (trim silence, seek to just before the next onset)', () => {
  it('seeks forward to g.e - ONSET_GUARD when inside a gap past the keep floor', async () => {
    const { gapTick } = await import('./gapSpeed.js')
    const el = fakeEl({ currentTime: 1.5 })
    const sync = syncBag([{ s: 1.0, e: 2.0 }], { G: 1, Sp: 2 }) // dur=3
    const to = gapTick(el, sync, 1.5)
    expect(to).toBeCloseTo(1.86, 5)          // 2.0 - ONSET_GUARD(0.14)
    expect(el.currentTime).toBeCloseTo(1.86, 5)
    expect(sync.pendingSeeks).toEqual([expect.closeTo(1.86, 5)]) // seek attributed for onSeeked
  })
  it('leaves a short gap alone when the hop would not move us meaningfully forward', async () => {
    const { gapTick } = await import('./gapSpeed.js')
    // currentTime already within ONSET_GUARD of the gap end → to - t ≤ 0.04 → no seek
    const el = fakeEl({ currentTime: 1.94 })
    expect(gapTick(el, syncBag([{ s: 1.0, e: 2.0 }], { G: 1, Sp: 2 }), 1.5)).toBeNull()
  })
})

describe('gapTick — SLOW (replay silence once, seek back into the pure-silence zone)', () => {
  it('seeks back once as the gap end approaches, then marks the gap stretched', async () => {
    const { gapTick } = await import('./gapSpeed.js')
    const el = fakeEl({ currentTime: 1.9 })
    const sync = syncBag([{ s: 1.0, e: 2.0 }], { G: 1, Sp: 2 }) // f = 2 → extra = 1
    const to = gapTick(el, sync, 0.75)
    expect(to).toBeCloseTo(1.16, 5)          // max(g.s + TAIL_GUARD(0.16), t - extra(1)) = max(1.16, 0.9)
    expect(el.currentTime).toBeCloseTo(1.16, 5)
    expect(sync.stretched.has(0)).toBe(true) // won't stretch this gap again
    // a second tick on the same gap does not stretch again
    el.currentTime = 1.9
    expect(gapTick(el, sync, 0.75)).toBeNull()
  })
  it('never replays past the previous word (stays ≥ TAIL_GUARD from gap start)', async () => {
    const { gapTick } = await import('./gapSpeed.js')
    const el = fakeEl({ currentTime: 1.9 })
    const sync = syncBag([{ s: 1.0, e: 2.0 }], { G: 1, Sp: 2 })
    const to = gapTick(el, sync, 0.75)
    expect(to).toBeGreaterThanOrEqual(1.0 + 0.16) // TAIL_GUARD floor
  })
})

describe('exported constants (the tuned guards)', () => {
  it('MIN_GAP and MIN_KEPT are the reviewed values', () => {
    expect(MIN_GAP).toBe(0.35)
    expect(MIN_KEPT).toBe(0.18)
  })
})
