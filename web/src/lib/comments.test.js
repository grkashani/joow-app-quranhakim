// Characterization tests for the community-comments client.
// These PIN the CURRENT behavior of the pure media-src prefixing and the exact
// request SHAPES (URL + method + headers + body) that fetchComments /
// fetchCommentCounts / postComment / uploadContrib send. A later refactor that
// changes any of these fails loudly. We assert what the code DOES today.
//
// data.js (AUDIO_BASE) and auth.js (getToken) are mocked so the API prefix and
// the auth token are deterministic; global.fetch is stubbed per test.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// A distinctive, NON-empty base so the prefixing is visible in assertions
// (this is the Capacitor/native case; on web AUDIO_BASE is '').
const API = 'https://quranner.com'
vi.mock('./data.js', () => ({ AUDIO_BASE: 'https://quranner.com' }))

// getToken is hoisted-mocked so tests can flip the token per case.
const { getTokenMock } = vi.hoisted(() => ({ getTokenMock: vi.fn(() => '') }))
vi.mock('./auth.js', () => ({ getToken: getTokenMock }))

import { mediaSrc, fetchComments, fetchCommentCounts, postComment, uploadContrib } from './comments.js'

const okResp = (json) => ({ ok: true, status: 200, json: async () => json })
const errResp = (status, json) => ({ ok: false, status, json: async () => json })
const badJsonResp = (status) => ({ ok: false, status, json: async () => { throw new Error('bad json') } })

beforeEach(() => {
  global.fetch = vi.fn()
  getTokenMock.mockReturnValue('') // default: no token
})

describe('mediaSrc — API-prefixes only /api/ refs, passes everything else through', () => {
  it('prefixes a stored /api/ media ref with the API base', () => {
    expect(mediaSrc('/api/contrib/media/abc.png')).toBe(`${API}/api/contrib/media/abc.png`)
  })
  it('leaves an already-absolute URL untouched (does not start with /api/)', () => {
    expect(mediaSrc('https://cdn.example.com/x.png')).toBe('https://cdn.example.com/x.png')
  })
  it('leaves a non-/api/ relative path untouched', () => {
    expect(mediaSrc('/recitation/002/002_005.mp3')).toBe('/recitation/002/002_005.mp3')
  })
  it('passes falsy values straight through (no prefix)', () => {
    // NOTE: pins current behavior — empty/null/undefined short-circuit before startsWith
    expect(mediaSrc('')).toBe('')
    expect(mediaSrc(null)).toBe(null)
    expect(mediaSrc(undefined)).toBe(undefined)
  })
})

describe('fetchComments — GET request shape', () => {
  it('GETs /api/comments with surah + ayah query and returns the comments array', async () => {
    global.fetch.mockResolvedValue(okResp({ comments: [{ id: 1 }, { id: 2 }] }))
    const out = await fetchComments(2, 5)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][0]).toBe(`${API}/api/comments?surah=2&ayah=5`)
    expect(global.fetch.mock.calls[0][1]).toBeUndefined() // no init → GET
    expect(out).toEqual([{ id: 1 }, { id: 2 }])
  })
  it('defaults ayah to 0 (surah-level) when omitted', async () => {
    global.fetch.mockResolvedValue(okResp({ comments: [] }))
    await fetchComments(114)
    expect(global.fetch.mock.calls[0][0]).toBe(`${API}/api/comments?surah=114&ayah=0`)
  })
  it('returns [] when the payload has no comments key', async () => {
    global.fetch.mockResolvedValue(okResp({}))
    expect(await fetchComments(2, 1)).toEqual([])
  })
  it('throws "comments <status>" on a non-ok response', async () => {
    global.fetch.mockResolvedValue(errResp(500, {}))
    await expect(fetchComments(2, 1)).rejects.toThrow('comments 500')
  })
})

describe('fetchCommentCounts — best-effort GET, never throws', () => {
  it('GETs /api/comments with counts=1 and returns the counts map', async () => {
    global.fetch.mockResolvedValue(okResp({ counts: { 0: 3, 5: 1 } }))
    const out = await fetchCommentCounts(2)
    expect(global.fetch.mock.calls[0][0]).toBe(`${API}/api/comments?surah=2&counts=1`)
    expect(out).toEqual({ 0: 3, 5: 1 })
  })
  it('returns {} when payload has no counts key', async () => {
    global.fetch.mockResolvedValue(okResp({}))
    expect(await fetchCommentCounts(2)).toEqual({})
  })
  it('returns {} (no throw) on a non-ok response', async () => {
    global.fetch.mockResolvedValue(errResp(404, {}))
    expect(await fetchCommentCounts(2)).toEqual({})
  })
  it('returns {} (no throw) when fetch itself rejects', async () => {
    global.fetch.mockRejectedValue(new Error('network down'))
    expect(await fetchCommentCounts(2)).toEqual({})
  })
})

describe('postComment — POST body + auth header shape', () => {
  it('POSTs JSON with the exact body, no auth header when there is no token', async () => {
    global.fetch.mockResolvedValue(okResp({ comment: { id: 9 } }))
    const out = await postComment(2, 5, 'Ali', 'salaam', [{ id: 'm1' }])
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe(`${API}/api/comments`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' }) // no authorization
    expect(JSON.parse(init.body)).toEqual({ surah: 2, ayah: 5, name: 'Ali', text: 'salaam', media: [{ id: 'm1' }] })
    expect(out).toEqual({ id: 9 }) // returns d.comment
  })
  it('adds a Bearer authorization header only when a token exists', async () => {
    getTokenMock.mockReturnValue('tok123')
    global.fetch.mockResolvedValue(okResp({ comment: {} }))
    await postComment(2, 5, 'Ali', 'hi', null)
    expect(global.fetch.mock.calls[0][1].headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer tok123',
    })
  })
  it('coerces a falsy ayah to 0 and omits media when none/empty', async () => {
    global.fetch.mockResolvedValue(okResp({ comment: {} }))
    await postComment(2, undefined, 'Ali', 'hi', [])
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ surah: 2, ayah: 0, name: 'Ali', text: 'hi' })
  })
  it('omits the media key when media is undefined', async () => {
    global.fetch.mockResolvedValue(okResp({ comment: {} }))
    await postComment(3, 7, 'Sara', 'text')
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ surah: 3, ayah: 7, name: 'Sara', text: 'text' })
  })
  it('throws the server error message when present', async () => {
    global.fetch.mockResolvedValue(errResp(400, { error: 'name required' }))
    await expect(postComment(2, 5, '', 'x')).rejects.toThrow('name required')
  })
  it('throws "post <status>" when the error body cannot be parsed', async () => {
    // NOTE: pins current behavior — json() rejects → d = {} → falls back to status
    global.fetch.mockResolvedValue(badJsonResp(503))
    await expect(postComment(2, 5, 'Ali', 'hi')).rejects.toThrow('post 503')
  })
})

describe('uploadContrib — POST blob body + query shape', () => {
  it('POSTs the blob to /api/contrib/upload with surah+ayah query and blob mime as content-type', async () => {
    getTokenMock.mockReturnValue('tokABC')
    global.fetch.mockResolvedValue(okResp({ id: 'x', url: '/api/contrib/media/x.png' }))
    const blob = { type: 'image/png' }
    const out = await uploadContrib(2, 5, blob)
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe(`${API}/api/contrib/upload?surah=2&ayah=5`)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(blob) // raw blob streamed as body
    expect(init.headers).toEqual({ 'content-type': 'image/png', authorization: 'Bearer tokABC' })
    expect(out).toEqual({ id: 'x', url: '/api/contrib/media/x.png' }) // returns whole payload
  })
  it('defaults ayah to 0, falls back content-type to octet-stream, and omits auth without a token', async () => {
    global.fetch.mockResolvedValue(okResp({ id: 'y' }))
    await uploadContrib(9, 0, {}) // blob with no .type, no token
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe(`${API}/api/contrib/upload?surah=9&ayah=0`)
    expect(init.headers).toEqual({ 'content-type': 'application/octet-stream' }) // no authorization
  })
  it('appends name (after surah/ayah) and a rounded dur when provided', async () => {
    global.fetch.mockResolvedValue(okResp({ id: 'z' }))
    await uploadContrib(2, 5, { type: 'audio/webm' }, { name: 'Ali', dur: 3.7 })
    expect(global.fetch.mock.calls[0][0]).toBe(`${API}/api/contrib/upload?surah=2&ayah=5&name=Ali&dur=4`)
  })
  it('throws "upload <status>" on a non-ok response with no error body', async () => {
    global.fetch.mockResolvedValue(errResp(413, {}))
    await expect(uploadContrib(2, 5, { type: 'image/png' })).rejects.toThrow('upload 413')
  })
})
