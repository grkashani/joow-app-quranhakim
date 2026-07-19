import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { initSettings } from './lib/settings.js'
import { initAuth } from './lib/auth.js'
import { resumeDownloadAllIfPending } from './lib/downloads.js'
import './index.css'

initSettings()
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
