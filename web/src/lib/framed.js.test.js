// @vitest-environment jsdom
//
// CHARACTERIZATION tests for the shell/embed bridge helpers. These PIN the
// CURRENT behavior of framed.js so a later refactor that changes it fails
// loudly. They assert what the code DOES today — where that looks buggy the
// test still pins it (marked "NOTE: pins current (possibly-wrong) behavior")
// and the code is left untouched.
//
// The module reads window.parent, document.referrer and import.meta.env only
// INSIDE its functions (never at import time), so every branch is drivable by
// stubbing those before each call. initExternalContext registers an anonymous
// window 'message' listener it never removes — we spy on addEventListener to
// capture each handler and tear it down between tests so they don't accumulate.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isFramed,
  shellHostOrigin,
  postToShell,
  initExternalContext,
  getShellUser,
  setShellUser,
  SHELL_USER_EVENT,
  SHELL_APPEARANCE_EVENT,
} from './framed.js'

// Native addEventListener, captured once before any spy replaces it.
const realAdd = window.addEventListener.bind(window)

// --- stub helpers -----------------------------------------------------------
function standalone() {
  Object.defineProperty(window, 'parent', { configurable: true, value: window })
}
function framedWith(parentPostMessage = vi.fn()) {
  const parent = { postMessage: parentPostMessage }
  Object.defineProperty(window, 'parent', { configurable: true, value: parent })
  return parent
}
function setReferrer(value) {
  Object.defineProperty(document, 'referrer', { configurable: true, value })
}
function fakeMsg({ data, origin, source }) {
  return new MessageEvent('message', { data, origin, source })
}

let capturedMsgHandlers = []

beforeEach(() => {
  setShellUser(null) // reset the module-level shell-user store
  standalone() // default: not embedded
  setReferrer('') // default: no referrer
  vi.unstubAllEnvs()
  capturedMsgHandlers = []
  vi.spyOn(window, 'addEventListener').mockImplementation((type, handler, opts) => {
    if (type === 'message') capturedMsgHandlers.push(handler)
    return realAdd(type, handler, opts)
  })
})

afterEach(() => {
  // Tear down every 'message' listener initExternalContext registered so they
  // can't leak into the next test.
  for (const h of capturedMsgHandlers) window.removeEventListener('message', h)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('exported event-name constants', () => {
  it('are the stable strings the UI + shell.js agree on', () => {
    expect(SHELL_APPEARANCE_EVENT).toBe('jq:shell-appearance')
    expect(SHELL_USER_EVENT).toBe('jq:shell-user')
  })
})

describe('isFramed', () => {
  it('is false standalone (parent === window)', () => {
    standalone()
    expect(isFramed()).toBe(false)
  })

  it('is true when embedded under a distinct parent', () => {
    framedWith()
    expect(isFramed()).toBe(true)
  })

  it('treats a cross-origin parent that throws on access as framed', () => {
    Object.defineProperty(window, 'parent', {
      configurable: true,
      get() { throw new Error('cross-origin denied') },
    })
    expect(isFramed()).toBe(true)
  })
})

describe('shell-user store (getShellUser / setShellUser)', () => {
  it('stores a card that has a name or a picture and broadcasts SHELL_USER_EVENT', () => {
    const seen = []
    const onEvt = (e) => seen.push(e.detail)
    window.addEventListener(SHELL_USER_EVENT, onEvt)
    setShellUser({ name: 'Ali', picture: 'p.png' })
    expect(getShellUser()).toEqual({ name: 'Ali', picture: 'p.png' })
    expect(seen).toEqual([{ name: 'Ali', picture: 'p.png' }])
    window.removeEventListener(SHELL_USER_EVENT, onEvt)
  })

  it('rejects a card with neither name nor picture, and null, storing null', () => {
    setShellUser({ id: 'x' }) // no name, no picture
    expect(getShellUser()).toBeNull()
    setShellUser(null)
    expect(getShellUser()).toBeNull()
  })
})

describe('shellHostOrigin — precedence', () => {
  it('defaults to the canonical production origin with no referrer or env', () => {
    setReferrer('')
    expect(shellHostOrigin()).toBe('https://yquran.com')
  })

  it('uses the explicit configured host (origin only) when set and no referrer', () => {
    setReferrer('')
    vi.stubEnv('VITE_JOOW_HOST_ORIGIN', 'https://host.example/some/path')
    expect(shellHostOrigin()).toBe('https://host.example')
  })

  it('falls back to canonical when the configured host is a non-http(s) URL', () => {
    setReferrer('')
    vi.stubEnv('VITE_JOOW_HOST_ORIGIN', 'ftp://nope.example')
    expect(shellHostOrigin()).toBe('https://yquran.com')
  })

  it('prefers the referrer origin over the configured host', () => {
    // NOTE: pins current (possibly-wrong) behavior — trustedHostOrigins() adds
    // the referrer's origin to the trusted set, so ANY http(s) referrer is
    // treated as trusted and wins here, even a non-yquran host.
    setReferrer('https://embed.example.org/reader?x=1')
    vi.stubEnv('VITE_JOOW_HOST_ORIGIN', 'https://host.example')
    expect(shellHostOrigin()).toBe('https://embed.example.org')
  })
})

describe('postToShell', () => {
  it('is a no-op returning false when standalone', () => {
    standalone()
    expect(postToShell({ type: 'jq:share' })).toBe(false)
  })

  it('posts up to the parent, origin-pinned to shellHostOrigin(), returning true', () => {
    setReferrer('')
    vi.stubEnv('VITE_JOOW_HOST_ORIGIN', 'https://host.example')
    const post = vi.fn()
    framedWith(post)
    const msg = { type: 'jq:minimize' }
    expect(postToShell(msg)).toBe(true)
    expect(post).toHaveBeenCalledWith(msg, 'https://host.example')
  })

  it('returns false when the parent postMessage throws', () => {
    framedWith(() => { throw new Error('cross-origin denied') })
    expect(postToShell({ type: 'x' })).toBe(false)
  })
})

describe('initExternalContext — message handling', () => {
  it('registers no message listener when standalone, and a context changes nothing', () => {
    standalone()
    initExternalContext()
    expect(capturedMsgHandlers).toHaveLength(0)
    window.dispatchEvent(fakeMsg({
      data: { type: 'joow:external-context', user: { displayName: 'Z' } },
      origin: 'https://yquran.com',
    }))
    expect(getShellUser()).toBeNull()
  })

  it('accepts a joow:external-context from a TRUSTED origin: sets the shell user + acks', () => {
    framedWith()
    setReferrer('') // trusted = { https://yquran.com }
    initExternalContext()
    const source = { postMessage: vi.fn() }
    window.dispatchEvent(fakeMsg({
      data: {
        type: 'joow:external-context',
        user: { displayName: 'Ali', avatarUrl: 'https://cdn/x.png', memberId: 42 },
      },
      origin: 'https://yquran.com',
      source,
    }))
    expect(getShellUser()).toEqual({ name: 'Ali', picture: 'https://cdn/x.png', id: '42' })
    expect(source.postMessage).toHaveBeenCalledWith(
      { type: 'joow:external-context-ack' },
      'https://yquran.com',
    )
  })

  it('also trusts the referrer origin (origin-pinned to the embedding host)', () => {
    framedWith()
    setReferrer('https://embed.example.org/app')
    initExternalContext()
    const source = { postMessage: vi.fn() }
    window.dispatchEvent(fakeMsg({
      data: { type: 'joow:external-context', user: { displayName: 'Sara' } },
      origin: 'https://embed.example.org',
      source,
    }))
    expect(getShellUser()).toEqual({ name: 'Sara', picture: '', id: '' })
    expect(source.postMessage).toHaveBeenCalledTimes(1)
  })

  it('IGNORES a context from an UNTRUSTED origin — no user, no ack', () => {
    framedWith()
    setReferrer('') // trusted = { https://yquran.com }
    initExternalContext()
    const source = { postMessage: vi.fn() }
    window.dispatchEvent(fakeMsg({
      data: { type: 'joow:external-context', user: { displayName: 'Mallory' } },
      origin: 'https://evil.attacker.test',
      source,
    }))
    expect(getShellUser()).toBeNull()
    expect(source.postMessage).not.toHaveBeenCalled()
  })

  it('ignores messages whose type is not joow:external-context (and null data)', () => {
    framedWith()
    setReferrer('')
    initExternalContext()
    const source = { postMessage: vi.fn() }
    window.dispatchEvent(fakeMsg({
      data: { type: 'something-else', user: { displayName: 'X' } },
      origin: 'https://yquran.com',
      source,
    }))
    window.dispatchEvent(fakeMsg({ data: null, origin: 'https://yquran.com', source }))
    expect(getShellUser()).toBeNull()
    expect(source.postMessage).not.toHaveBeenCalled()
  })

  it('maps a trusted user with only a memberId to a null shell user, yet still acks', () => {
    // NOTE: pins current (possibly-wrong) behavior — a memberId-only user maps
    // to { name:'', picture:'', id:'7' }; setShellUser then rejects it because
    // both name AND picture are empty, so getShellUser() is null even though the
    // host was trusted and an ack IS sent.
    framedWith()
    setReferrer('')
    initExternalContext()
    const source = { postMessage: vi.fn() }
    window.dispatchEvent(fakeMsg({
      data: { type: 'joow:external-context', user: { memberId: 7 } },
      origin: 'https://yquran.com',
      source,
    }))
    expect(getShellUser()).toBeNull()
    expect(source.postMessage).toHaveBeenCalledWith(
      { type: 'joow:external-context-ack' },
      'https://yquran.com',
    )
  })
})
