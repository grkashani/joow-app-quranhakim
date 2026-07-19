import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { search } from '../lib/search.js'
import { useI18n } from '../lib/i18n.jsx'

export default function WordSearch() {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadPct, setLoadPct] = useState(0)
  const [res, setRes] = useState(null)
  const timer = useRef(null)

  useEffect(() => {
    clearTimeout(timer.current)
    if (!query.trim()) { setRes(null); return }
    timer.current = setTimeout(async () => {
      setBusy(true)
      const r = await search(query, {}, (d, t) => setLoadPct(Math.round((d / t) * 100)))
      setRes(r)
      setBusy(false)
    }, 350)
    return () => clearTimeout(timer.current)
  }, [query])

  return (
    <div className="jq-shell jq-page">
      <h1 className="jq-page-title">{t('wordTitle')}</h1>
      <p className="jq-page-sub">{t('wordSub')}</p>

      <div className="jq-search">
        <input
          className="jq-search-input"
          placeholder={t('wordPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      {busy && <div className="jq-loading">{t('searching')} {loadPct > 0 && loadPct < 100 ? `(${loadPct}%)` : ''}</div>}

      {res && !busy && (
        <>
          <div className="jq-result-count">
            {res.total > 0 ? `${res.total}${res.capped ? '+' : ''} ${t('results')}` : t('noResults')}
          </div>
          <ul className="jq-results">
            {res.results.map((r, i) => (
              <li key={`${r.surah}-${r.n}-${i}`}>
                <Link className="jq-result" to={`/surah/${r.surah}#a${r.n}`}>
                  <div className="jq-result-ref">
                    <span className="jq-result-surah">{r.nameFa}</span>
                    <span className="jq-result-ayah">{t('ayah')} {r.n}</span>
                  </div>
                  <p className="jq-ar jq-result-ar" dir="rtl">{r.ar}</p>
                  {r.fa && <p className="jq-fa" dir="rtl">{r.fa}</p>}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
