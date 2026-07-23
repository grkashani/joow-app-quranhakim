// JooW SDK shell bridge — the minimal handshake that turns the reader into a
// first-class JooW mini-app when it is mounted inside the super-app shell.
//
// This ONLY does anything when framed (window.parent !== window). Standalone
// (quranner.com) and native (Capacitor) behaviour is completely unchanged: the
// SDK is never constructed and no bridge is attached unless we are embedded.
//
// The handshake (see @joow/sdk AppFrameBridge):
//   1. The shell posts an origin-verified `joow:launch` with a one-time launch
//      code + the host appearance ({theme, lang, dir}) + the user's public card.
//   2. attachBridge() exchanges the launch code into a cookie-mode app session,
//      then emits `joow:ready` — completing the handshake.
//   3. onLaunch / onAppearance / onAppearanceChange keep the reader mirrored to
//      the SHELL-owned appearance, and expose the shell's user card to the UI.
import { JoowSdk } from '@joow/sdk'
import { applyTheme } from './settings.js'
import { isFramed, SHELL_APPEARANCE_EVENT, setShellUser } from './framed.js'

const APP_ID = 'quranhakim'
// The manifest declares no surfaces → one implicit "main" surface, which is
// also what a bare AppFrame launch opens (manifest.DefaultSurfaceID()).
const SURFACE = 'main'

function originOf(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : ''
  } catch {
    return ''
  }
}

// The exact JooW shell origin that framed us. The SDK bridge pins this origin
// on every inbound + outbound postMessage, so it must be the shell's real
// origin (e.g. https://stage.joow.org / https://joow.org). A build-time
// override wins; otherwise we derive it from the framing document (referrer).
function resolveHostOrigin() {
  const explicit = String(import.meta.env.VITE_JOOW_HOST_ORIGIN || '').trim()
  if (explicit) return originOf(explicit)
  // The shell document that loaded this iframe is our referrer; its origin is
  // the host origin. (Set VITE_JOOW_HOST_ORIGIN explicitly if the shell sends
  // no referrer, e.g. under a strict Referrer-Policy: no-referrer.)
  const ref = originOf(typeof document !== 'undefined' ? document.referrer : '')
  if (ref && ref.startsWith('https://')) return ref
  if (ref && import.meta.env.DEV) return ref
  return ''
}

// Canonical signals.v4 Appearance → the reader's {theme, lang, dir}.
function themeOf(appearance) {
  if (!appearance) return null
  if (appearance.themeMode === 'dark' || appearance.themeMode === 'light') return appearance.themeMode
  if (appearance.resolvedTheme === 'dark' || appearance.resolvedTheme === 'light') return appearance.resolvedTheme
  return null
}

function applyAppearance(appearance) {
  if (!appearance) return
  const theme = themeOf(appearance)
  // applyTheme sets <html data-theme> WITHOUT persisting — the shell owns the
  // theme while framed, so we never overwrite the user's standalone choice.
  if (theme) applyTheme(theme)
  const lang = appearance.language || 'en'
  const dir = appearance.direction === 'rtl' ? 'rtl' : 'ltr'
  window.dispatchEvent(new CustomEvent(SHELL_APPEARANCE_EVENT, { detail: { lang, dir, theme } }))
}

// The bridge only delivers a user card when the session grants identity.read
// (our manifest requests it). Map it to the reader's { name, picture } shape.
function applyUser(user) {
  setShellUser(user && (user.displayName || user.avatarUrl)
    ? { name: user.displayName || '', picture: user.avatarUrl || '' }
    : null)
}

let _sdk = null

// Construct the SDK + attach the frame bridge. Safe to call unconditionally on
// startup; it no-ops when not framed or when the host origin can't be resolved.
export function initShellBridge() {
  if (_sdk || !isFramed()) return null
  const allowedHostOrigin = resolveHostOrigin()
  if (!allowedHostOrigin) {
    // Framed but no resolvable shell origin — attach would throw. Fail soft:
    // the reader still renders in-frame, just without host appearance/identity.
    console.warn('[joow] framed but no shell origin resolved; set VITE_JOOW_HOST_ORIGIN — bridge not attached')
    return null
  }
  try {
    _sdk = new JoowSdk({ appId: APP_ID, surface: SURFACE })
    _sdk.attachBridge({
      allowedHostOrigin,
      appId: APP_ID,
      surface: SURFACE,
      // Fired after the launch code is captured (attachBridge exchanges it,
      // then emits joow:ready). Seed appearance + identity from the launch.
      onLaunch: (ctx) => {
        applyAppearance(ctx.appearance)
        applyUser(ctx.user)
      },
      // joow:appearance carries the refreshed user card alongside appearance.
      onAppearance: (signal) => {
        applyAppearance(signal.appearance)
        if (signal && 'user' in signal) applyUser(signal.user)
      },
      // Fires for every host appearance update (theme / lang / dir toggles).
      onAppearanceChange: (appearance) => {
        applyAppearance(appearance)
      },
    })
  } catch (err) {
    console.warn('[joow] bridge attach failed:', err && err.message ? err.message : err)
    _sdk = null
  }
  return _sdk
}

export function getSdk() {
  return _sdk
}
