import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { askQuranGpt } from '../lib/quranGpt.js'
import { useI18n } from '../lib/i18n.jsx'

export default function QuranGPT() {
  const { t } = useI18n()
  const SUGGESTIONS = [t('gptSug1'), t('gptSug2'), t('gptSug3'), t('gptSug4')]
  const [messages, setMessages] = useState([
    { role: 'assistant', answer: t('gptGreeting'), sources: [] },
  ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, busy])

  async function ask(q) {
    const question = (q ?? input).trim()
    if (!question || busy) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', text: question }])
    setBusy(true)
    const reply = await askQuranGpt(question, messages.filter((m) => m.role === 'user').map((m) => m.text))
    setMessages((m) => [...m, { role: 'assistant', ...reply }])
    setBusy(false)
  }

  return (
    <div className="jq-shell jq-page jq-gpt">
      <div className="jq-gpt-head">
        <h1 className="jq-page-title">{t('gptTitle')}</h1>
        <span className="jq-gpt-badge">✦ AI</span>
      </div>

      <div className="jq-chat">
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="jq-msg jq-msg-user"><p dir="rtl">{m.text}</p></div>
          ) : (
            <div key={i} className="jq-msg jq-msg-bot">
              <p dir="rtl">{m.answer}</p>
              {m.sources?.length > 0 && (
                <ul className="jq-gpt-sources">
                  {m.sources.map((s, j) => (
                    <li key={j}>
                      <Link className="jq-gpt-source" to={`/surah/${s.surah}#a${s.n}`}>
                        <span className="jq-gpt-source-ref">{s.nameFa} · {s.n}</span>
                        <span className="jq-ar jq-gpt-source-ar" dir="rtl">{s.ar}</span>
                        {s.fa && <span className="jq-fa" dir="rtl">{s.fa}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ),
        )}
        {busy && <div className="jq-msg jq-msg-bot"><p className="jq-typing">{t('gptSearching')}</p></div>}
        <div ref={endRef} />
      </div>

      {messages.length <= 1 && (
        <div className="jq-gpt-suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="jq-chip" onClick={() => ask(s)}>{s}</button>
          ))}
        </div>
      )}

      <form className="jq-gpt-input" onSubmit={(e) => { e.preventDefault(); ask() }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('gptPlaceholder')}
        />
        <button type="submit" disabled={busy || !input.trim()} aria-label="ارسال">↑</button>
      </form>
    </div>
  )
}
