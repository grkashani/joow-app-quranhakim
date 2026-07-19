// Tiny, dependency-free helpers shared by the UI and the JooW SDK bridge.
//
// Kept SEPARATE from shell.js (which imports the heavy @joow/sdk bundle) so UI
// components can import the in-shell check + the shell-user store WITHOUT
// pulling the SDK into their chunks. The SDK is only loaded through shell.js,
// which main.jsx invokes once at startup.

// True when the reader runs embedded inside a host frame (the JooW super-app
// shell mounts it via an <iframe>). Standalone web / native Capacitor builds
// are never framed, so every shell-only branch below stays dormant there.
// A cross-origin parent throws on property access — which itself means we ARE
// embedded, so treat the throw as "framed".
export function isFramed() {
  try {
    return typeof window !== 'undefined' && !!window.parent && window.parent !== window
  } catch {
    return true
  }
}

// The host (shell) owns appearance while framed. shell.js re-broadcasts each
// host appearance update as this event so the React i18n provider can mirror
// the shell's content language + layout direction.
export const SHELL_APPEARANCE_EVENT = 'jq:shell-appearance'
// The host-provided public identity (displayName/avatarUrl). shell.js sets it;
// TopBar + Profile render it in place of the reader's own sign-in.
export const SHELL_USER_EVENT = 'jq:shell-user'

// The shell user's PUBLIC display card, or null. Shape mirrors the reader's own
// account object ({ name, picture }) so existing UI can consume it unchanged.
let _shellUser = null
export function getShellUser() {
  return _shellUser
}
export function setShellUser(user) {
  _shellUser = user && (user.name || user.picture) ? user : null
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SHELL_USER_EVENT, { detail: _shellUser }))
  }
}

// ---- Interim external-embed identity (no SDK/apphost required) ----
// While the reader is framed as an EXTERNAL app (plain iframe, before the full
// AppFrame/apphost bridge goes live), the yQuran shell posts the signed-in
// user's PUBLIC display card as an origin-pinned `joow:external-context`
// message (see yquran ExternalAppFrame.tsx). Dependency-free on purpose: this
// must work without loading the @joow/sdk bundle.
const originOf = (url) => {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : ''
  } catch { return '' }
}
function trustedHostOrigins() {
  const set = new Set(['https://yquran.com'])
  const explicit = originOf(String(import.meta.env.VITE_JOOW_HOST_ORIGIN || '').trim())
  if (explicit) set.add(explicit)
  const ref = originOf(typeof document !== 'undefined' ? document.referrer : '')
  if (ref) set.add(ref)
  set.delete('') // never trust an empty origin
  return set
}
export function initExternalContext() {
  if (!isFramed() || typeof window === 'undefined') return
  const trusted = trustedHostOrigins()
  window.addEventListener('message', (e) => {
    const d = e.data
    if (!d || d.type !== 'joow:external-context') return
    if (!trusted.has(e.origin)) return
    const u = d.user
    setShellUser(u && (u.displayName || u.avatarUrl || u.memberId)
      ? { name: String(u.displayName || ''), picture: String(u.avatarUrl || ''), id: u.memberId ? String(u.memberId) : '' }
      : null)
    // Ack so the host can stop re-posting (it retries while we boot).
    try { e.source && e.source.postMessage({ type: 'joow:external-context-ack' }, e.origin) } catch { /* host gone */ }
  })
}
