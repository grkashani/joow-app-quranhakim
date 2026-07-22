// @vitest-environment jsdom
//
// Characterization tests for the single-ayah share flow. These PIN current
// behavior: the exact embed URL shape, and shareAyah's branch selection between
// the FRAMED hand-off (postToShell 'joow:external-share') and the STANDALONE
// native-share / clipboard fallbacks. If a later refactor changes any of these,
// that is a deliberate behavior change to make — not an accident.
//
// framed.js (isFramed / postToShell) is mocked so we drive each branch directly
// and never touch the real postMessage / SDK path. The env is jsdom for
// location.origin + navigator; canvas is NOT available here (getContext returns
// null), which is exactly why buildAyahCard yields null below.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./framed.js', () => ({
  isFramed: vi.fn(() => false),
  postToShell: vi.fn(() => false),
}))

import { ayahEmbedUrl, shareAyah } from './shareAyah.js'
import { isFramed, postToShell } from './framed.js'

// jsdom's default document origin. ayahEmbedUrl reads location.origin.
const ORIGIN = 'http://localhost:3000'

// navigator.share / navigator.clipboard are undefined in bare jsdom; define them
// per-test via configurable descriptors and remove them again afterwards.
function setShare(fn) {
  Object.defineProperty(navigator, 'share', { value: fn, configurable: true, writable: true })
}
function setClipboard(obj) {
  Object.defineProperty(navigator, 'clipboard', { value: obj, configurable: true, writable: true })
}
function clearNav() {
  try { delete navigator.share } catch { /* ignore */ }
  try { delete navigator.clipboard } catch { /* ignore */ }
}

beforeEach(() => {
  isFramed.mockReset().mockReturnValue(false)
  postToShell.mockReset().mockReturnValue(false)
  clearNav()
})
afterEach(() => { clearNav() })

describe('ayahEmbedUrl', () => {
  it('builds the canonical /ayah/:s/:a path off location.origin', () => {
    expect(ayahEmbedUrl(2, 255)).toBe(`${ORIGIN}/ayah/2/255`)
  })

  it('interpolates the raw args verbatim (string args pass straight through)', () => {
    expect(ayahEmbedUrl('2', '255')).toBe(`${ORIGIN}/ayah/2/255`)
  })

  it('does not validate a missing ayah — bakes "undefined" into the path', () => {
    // NOTE: pins current (possibly-wrong) behavior — no arg checking, so a
    // missing ayah stringifies to "undefined" inside the URL.
    expect(ayahEmbedUrl(1)).toBe(`${ORIGIN}/ayah/1/undefined`)
  })
})

describe('shareAyah — FRAMED (hand off to the yQuran shell)', () => {
  it('posts a joow:external-share of kind "ayah" and returns "shared-to-yquran"', async () => {
    isFramed.mockReturnValue(true)
    postToShell.mockReturnValue(true)

    const res = await shareAyah('2', '255')

    expect(res).toBe('shared-to-yquran')
    expect(postToShell).toHaveBeenCalledTimes(1)
    const msg = postToShell.mock.calls[0][0]
    expect(msg).toMatchObject({
      type: 'joow:external-share',
      kind: 'ayah',
      surah: 2,          // Number()-coerced from the '2' string
      ayah: 255,         // Number()-coerced from the '255' string
      caption: 'Surah 2 · Ayah 255',
      url: `${ORIGIN}/ayah/2/255`,
    })
  })

  it('sends imageDataUrl=undefined when the card cannot render (no canvas in jsdom)', async () => {
    // NOTE: pins current behavior — buildAyahCard catches the null-context throw
    // and returns null, which the message normalizes to `undefined`.
    isFramed.mockReturnValue(true)
    postToShell.mockReturnValue(true)

    await shareAyah(2, 255)

    expect(postToShell.mock.calls[0][0].imageDataUrl).toBeUndefined()
  })

  it('honors opts: caption override, surahName/ayahLabel, and lang pass-through', async () => {
    isFramed.mockReturnValue(true)
    postToShell.mockReturnValue(true)

    await shareAyah(2, 255, { caption: 'My verse', surahName: 'Al-Baqarah', ayahLabel: 'Verse', lang: 'fa' })

    expect(postToShell.mock.calls[0][0]).toMatchObject({
      caption: 'My verse',   // explicit caption wins over the surahName/ayahLabel default
      lang: 'fa',
    })
  })

  it('composes the default caption from surahName + ayahLabel when no caption given', async () => {
    isFramed.mockReturnValue(true)
    postToShell.mockReturnValue(true)

    await shareAyah(2, 255, { surahName: 'Al-Baqarah', ayahLabel: 'Verse' })

    expect(postToShell.mock.calls[0][0].caption).toBe('Al-Baqarah · Verse 255')
  })

  it('falls through to the standalone path when postToShell reports failure', async () => {
    // Framed but the shell rejected the post (returned false) → no early return;
    // with no navigator.share, it lands on clipboard.
    isFramed.mockReturnValue(true)
    postToShell.mockReturnValue(false)
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })

    const res = await shareAyah(2, 255)

    expect(res).toBe('copied')
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/ayah/2/255`)
  })
})

describe('shareAyah — STANDALONE (native share / clipboard)', () => {
  it('uses navigator.share and returns "shared" on success', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    setShare(share)

    const res = await shareAyah(2, 255, { surahName: 'Al-Baqarah', ayahLabel: 'Verse' })

    expect(res).toBe('shared')
    expect(share).toHaveBeenCalledWith({
      title: 'Al-Baqarah · Verse 255',
      text: 'Al-Baqarah · Verse 255',
      url: `${ORIGIN}/ayah/2/255`,
    })
    expect(postToShell).not.toHaveBeenCalled()
  })

  it('treats a user-cancelled share (AbortError) as "shared" and skips clipboard', async () => {
    const share = vi.fn().mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
    const writeText = vi.fn().mockResolvedValue(undefined)
    setShare(share)
    setClipboard({ writeText })

    const res = await shareAyah(2, 255)

    expect(res).toBe('shared')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('falls back to clipboard → "copied" when share fails with a non-abort error', async () => {
    const share = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { name: 'NotAllowedError' }))
    const writeText = vi.fn().mockResolvedValue(undefined)
    setShare(share)
    setClipboard({ writeText })

    const res = await shareAyah(2, 255)

    expect(res).toBe('copied')
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/ayah/2/255`)
  })

  it('copies to clipboard → "copied" when no navigator.share exists', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })

    const res = await shareAyah(2, 255)

    expect(res).toBe('copied')
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/ayah/2/255`)
  })

  it('returns "failed" when clipboard.writeText rejects', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })

    expect(await shareAyah(2, 255)).toBe('failed')
  })

  it('returns "failed" when neither share nor clipboard is available', async () => {
    // NOTE: pins current behavior — reading navigator.clipboard.writeText throws
    // synchronously (clipboard undefined), the try/catch swallows it → 'failed'.
    expect(await shareAyah(2, 255)).toBe('failed')
  })
})
