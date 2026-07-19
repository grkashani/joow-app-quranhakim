import { useEffect, useRef, useState } from 'react'
import {
  isNative, signInApple, signInGoogleNative, submitGoogleCredential,
  makeGoogleWebNonce, appleConfigured, googleConfigured, GOOGLE_CLIENT_ID_WEB,
} from '../lib/auth.js'
import { useI18n } from '../lib/i18n.jsx'

function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true; s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('GIS failed to load'))
    document.head.appendChild(s)
  })
}

// Apple + Google sign-in. Calls onSignedIn(user) on success.
// With empty client IDs the buttons render but stay disabled/inert (build stays green).
export default function SignIn({ onSignedIn }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState(null)
  const gbtn = useRef(null)
  const appleOk = appleConfigured()
  const googleOk = googleConfigured()

  async function run(provider, fn) {
    setBusy(provider); setErr(null)
    try { const u = await fn(); if (u) onSignedIn?.(u) }
    catch { setErr(t('signInError')) }
    setBusy('')
  }

  // Web only: render Google's official GIS button. We mint an anti-replay nonce, hand the
  // SHA-256 hash to GIS, and keep the raw nonce to POST on the credential callback (verdict #6).
  useEffect(() => {
    if (isNative() || !GOOGLE_CLIENT_ID_WEB) return
    let cancelled = false
    let rawNonce = ''
    ;(async () => {
      const nonce = await makeGoogleWebNonce()
      rawNonce = nonce.raw
      await loadGis()
      if (cancelled || !gbtn.current) return
      const g = window.google
      g.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID_WEB,
        nonce: nonce.hashed,
        callback: async (resp) => {
          setBusy('google'); setErr(null)
          try {
            const u = await submitGoogleCredential(resp.credential, rawNonce)
            if (u) onSignedIn?.(u)
          } catch { setErr(t('signInError')) }
          setBusy('')
        },
        use_fedcm_for_button: true,
        auto_select: false,
      })
      g.accounts.id.renderButton(gbtn.current, {
        theme: 'outline', size: 'large', type: 'standard', shape: 'pill',
      })
    })().catch(() => { if (!cancelled) setErr(t('signInError')) })
    return () => { cancelled = true }
  }, [onSignedIn, t])

  return (
    <div className="jq-signin">
      <button className="jq-signin-btn jq-signin-apple" disabled={!!busy || !appleOk}
              onClick={() => run('apple', signInApple)}>
        {busy === 'apple' ? t('loading') : ` ${t('signInApple')}`}
      </button>

      {isNative() ? (
        <button className="jq-signin-btn jq-signin-google" disabled={!!busy || !googleOk}
                onClick={() => run('google', signInGoogleNative)}>
          {busy === 'google' ? t('loading') : `G  ${t('signInGoogle')}`}
        </button>
      ) : GOOGLE_CLIENT_ID_WEB ? (
        <div ref={gbtn} className="jq-signin-google-host" aria-label={t('signInGoogle')} />
      ) : (
        <button className="jq-signin-btn jq-signin-google" disabled aria-disabled="true">
          {`G  ${t('signInGoogle')}`}
        </button>
      )}

      {err && <div className="jq-comment-err">⚠︎ {err}</div>}
    </div>
  )
}
