import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { initSettings } from './lib/settings.js'
import { initAuth } from './lib/auth.js'
import { resumeDownloadAllIfPending } from './lib/downloads.js'
import { initShellBridge } from './lib/shell.js'
import { initExternalContext } from './lib/framed.js'
import './index.css'

initSettings()
// When mounted inside the JooW super-app shell (window.parent !== window),
// attach the SDK frame bridge: exchange the shell's one-time launch code and
// mirror the SHELL-owned appearance (theme/lang/dir) + identity. No-ops (never
// even constructs the SDK) in standalone web / native builds.
initShellBridge()
// Interim external-embed path (plain iframe, before apphost goes live): accept
// the shell's origin-pinned public user card so Profile/TopBar show the real
// signed-in member instead of "Guest user". No-op when not framed.
initExternalContext()
// Fire-and-forget: hydrate the session token (native cold-start reads Preferences) and
// validate it against /api/auth/me. Never blocks first paint.
initAuth()

// Serve downloaded audio/transcripts from the on-device cache (offline playback).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
}

// If a "download everything" was interrupted (reload / closed tab), continue it.
resumeDownloadAllIfPending()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
