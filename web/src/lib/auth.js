// Auth client for JoowQuran. Sign in with Apple / Google; stateless Bearer session token.
// Token: localStorage on web, Capacitor Preferences on native. Logout = drop the token.
//
// SECURITY — anti-replay nonce (adversarial verdict #6): every sign-in generates a fresh
// random raw nonce. We hand the SHA-256 hex of that nonce to Apple/Google (they echo it into
// the ID token's `nonce` claim) and forward the RAW nonce to our server, which must verify
// token.nonce === sha256hex(rawNonce). A captured ID token therefore cannot be replayed.
import { AUDIO_BASE } from './data.js'

const API = AUDIO_BASE // '' on web (same-origin), 'https://quranner.com' on native
const TOKEN_KEY = 'jq.token'
const USER_KEY = 'jq.user' // cached profile for instant paint; source of truth is /api/auth/me

// Public identifiers (safe to ship). Set in web/.env — see the deliverable env table.
// Empty-string fallbacks keep the build green and the UI inert until the owner sets real IDs.
const APPLE_SERVICE_ID_WEB = import.meta.env.VITE_APPLE_SERVICE_ID_WEB || ''
const APPLE_REDIRECT_URI = import.meta.env.VITE_APPLE_REDIRECT_URI || 'https://quranner.com/auth/apple/callback'
const APPLE_CLIENT_ID_IOS = 'com.joow.quran'
export const GOOGLE_CLIENT_ID_WEB = import.meta.env.VITE_GOOGLE_CLIENT_ID_WEB || ''
const GOOGLE_CLIENT_ID_IOS = import.meta.env.VITE_GOOGLE_CLIENT_ID_IOS || ''

// True only when the required client id for a provider is configured. The UI uses these to
// disable/hide buttons so an empty-config build renders but stays inert (no dead network calls).
export const appleConfigured = () => isNative() || !!APPLE_SERVICE_ID_WEB
export const googleConfigured = () =>
  isNative() ? !!GOOGLE_CLIENT_ID_IOS : !!GOOGLE_CLIENT_ID_WEB

export const isNative = () =>
  typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.()

// ---- anti-replay nonce (verdict #6) ----
// Random URL-safe raw nonce; the SHA-256 hex of it is what the provider receives.
function randomNonce() {
  const a = new Uint8Array(32)
  ;(window.crypto || crypto).getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}
async function sha256Hex(str) {
  const buf = await (window.crypto || crypto).subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}
// -> { raw, hashed }: pass `hashed` to the provider, send `raw` to our server.
async function makeNonce() {
  const raw = randomNonce()
  const hashed = await sha256Hex(raw)
  return { raw, hashed }
}

// ---- token storage (sync cache + async native persistence) ----
let _token = null
try { _token = localStorage.getItem(TOKEN_KEY) } catch { /* private mode */ }
export function getToken() { return _token || '' }

async function setToken(tok) {
  _token = tok || null
  try { tok ? localStorage.setItem(TOKEN_KEY, tok) : localStorage.removeItem(TOKEN_KEY) } catch {}
  if (isNative()) {
    const { Preferences } = await import('@capacitor/preferences')
    if (tok) await Preferences.set({ key: TOKEN_KEY, value: tok })
    else await Preferences.remove({ key: TOKEN_KEY })
  }
}
function cacheUser(user) {
  try { user ? localStorage.setItem(USER_KEY, JSON.stringify(user)) : localStorage.removeItem(USER_KEY) } catch {}
}
export function cachedUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)) } catch { return null }
}

// On native cold start, localStorage may be empty -> hydrate from Preferences, then validate.
export async function initAuth() {
  if (!_token && isNative()) {
    try {
      const { Preferences } = await import('@capacitor/preferences')
      const { value } = await Preferences.get({ key: TOKEN_KEY })
      if (value) _token = value
    } catch {}
  }
  return _token ? getMe().catch(() => null) : null
}

async function authPost(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `auth ${r.status}`)
  await setToken(d.token)
  cacheUser(d.user)
  return d.user
}

// ---- Apple JS SDK (web only), loaded lazily from Apple's CDN ----
function loadAppleJs() {
  if (window.AppleID) return Promise.resolve(window.AppleID)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js'
    s.onload = () => resolve(window.AppleID)
    s.onerror = () => reject(new Error('Apple JS failed to load'))
    document.head.appendChild(s)
  })
}

// ---- Sign in with Apple (both platforms) -> user ----
export async function signInApple() {
  const nonce = await makeNonce()
  if (isNative()) {
    if (!APPLE_CLIENT_ID_IOS) throw new Error('apple not configured')
    const { SignInWithApple } = await import('@capacitor-community/apple-sign-in')
    const res = await SignInWithApple.authorize({
      clientId: APPLE_CLIENT_ID_IOS,      // bundle id -> token aud on native
      redirectURI: APPLE_REDIRECT_URI,    // required field; unused by the native flow
      scopes: 'name email',
      nonce: nonce.hashed,                // Apple echoes this into the token's nonce claim
    })
    const { identityToken, givenName, familyName } = res.response
    const name = [givenName, familyName].filter(Boolean).join(' ') || undefined
    return authPost('/api/auth/apple', { identityToken, name, nonce: nonce.raw })
  }
  if (!APPLE_SERVICE_ID_WEB) throw new Error('apple not configured')
  const AppleID = await loadAppleJs()
  AppleID.auth.init({
    clientId: APPLE_SERVICE_ID_WEB,       // Services ID -> token aud on web
    scope: 'name email',
    redirectURI: APPLE_REDIRECT_URI,
    state: randomNonce(),
    nonce: nonce.hashed,                  // Apple echoes this into the token's nonce claim
    usePopup: true,                        // resolves in-SPA; no server redirect route needed
  })
  const data = await AppleID.auth.signIn()
  const name = data.user
    ? [data.user.name?.firstName, data.user.name?.lastName].filter(Boolean).join(' ') || undefined
    : undefined
  return authPost('/api/auth/apple', {
    identityToken: data.authorization.id_token, name, nonce: nonce.raw,
  })
}

// ---- Sign in with Google ----
// Native: drives the native GoogleSignIn SDK, returns the ID token JWT.
let _gInit = false
export async function signInGoogleNative() {
  if (!GOOGLE_CLIENT_ID_IOS) throw new Error('google not configured')
  const nonce = await makeNonce()
  const { SocialLogin } = await import('@capgo/capacitor-social-login')
  if (!_gInit) {
    await SocialLogin.initialize({
      google: {
        iOSClientId: GOOGLE_CLIENT_ID_IOS,       // iOS OAuth client
        iOSServerClientId: GOOGLE_CLIENT_ID_WEB, // web client (server-side auth code)
      },
    })
    _gInit = true
  }
  const res = await SocialLogin.login({
    provider: 'google',
    options: { scopes: ['email', 'profile'], nonce: nonce.hashed },
  })
  const idToken = res?.result?.idToken
  if (!idToken) throw new Error('no idToken from Google')
  return authPost('/api/auth/google', { idToken, nonce: nonce.raw })
}
// Web: GIS renders its own button; its callback hands us a credential (ID token JWT) plus the
// raw nonce we generated when initializing GIS (see SignIn.jsx).
export async function submitGoogleCredential(credential, rawNonce) {
  return authPost('/api/auth/google', { idToken: credential, nonce: rawNonce })
}

// Generate a nonce for the web GIS flow. SignIn.jsx passes `hashed` to google.accounts.id
// .initialize({ nonce }) and holds `raw` to send on the credential callback.
export async function makeGoogleWebNonce() {
  return makeNonce()
}

// ---- session ----
export async function getMe() {
  if (!getToken()) return null
  const r = await fetch(`${API}/api/auth/me`, { headers: { authorization: `Bearer ${getToken()}` } })
  if (r.status === 401) { await setToken(''); cacheUser(null); return null }
  if (!r.ok) throw new Error(`me ${r.status}`)
  const { user } = await r.json()
  cacheUser(user)
  return user
}
export async function signOut() { await setToken(''); cacheUser(null) }
