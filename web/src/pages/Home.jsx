import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { loadSurahIndex } from '../lib/data.js'
import { useI18n } from '../lib/i18n.jsx'

export default function Home() {
  const { t } = useI18n()
  const [surahs, setSurahs] = useState([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState(null)

  useEffect(() => {
    loadSurahIndex().then(setSurahs).catch((e) => setError(String(e)))
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return surahs
    return surahs.filter(
      (s) =>
        String(s.num) === q ||
        s.nameFa.includes(query.trim()) ||
        s.nameEn.toLowerCase().includes(q),
    )
  }, [surahs, query])

  return (
    <div className="jq-shell">
      <header className="jq-hero">
        <div className="jq-hero-title">{t('appName')}</div>
        <div className="jq-hero-sub">{t('appTagline')}</div>
      </header>

      <div className="jq-search">
        <input
          className="jq-search-input"
          placeholder={t('searchSurah')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && <div className="jq-error">{error}</div>}

      <ul className="jq-surah-list">
        {filtered.map((s) => (
          <li key={s.num}>
            <Link className="jq-surah-item" to={`/surah/${s.num}`}>
              <span className="jq-surah-num">{s.num}</span>
              <span className="jq-surah-names">
                <span className="jq-surah-fa">{s.nameFa}</span>
                <span className="jq-surah-en">{s.nameEn}</span>
              </span>
              <span className="jq-surah-count">{s.ttlVer} {t('ayahs')}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
