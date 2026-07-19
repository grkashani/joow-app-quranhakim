import { useEffect, useState } from 'react'
import { loadSurahIndex, loadReciters } from '../lib/data.js'
import { downloadedSet, downloadSurah, deleteSurah, deleteAll, estimateStorage, startDownloadAll, cancelDownloadAll, getAllProgress, subscribeAll } from '../lib/downloads.js'
import { useI18n } from '../lib/i18n.jsx'

const fmt = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB')

export default function Downloads() {
  const { t } = useI18n()
  const [surahs, setSurahs] = useState([])
  const [type, setType] = useState('tafsir')
  const [done, setDone] = useState(new Set())
  const [storage, setStorage] = useState({ usage: 0, quota: 0 })
  const [progress, setProgress] = useState(null) // {surah, pct}
  // Global download-all progress: initial value re-attaches to a run already in
  // flight (started earlier, on another page, or auto-resumed after a reload).
  const [allProg, setAllProg] = useState(getAllProgress())

  const refresh = async () => {
    setDone(await downloadedSet())
    setStorage(await estimateStorage())
  }
  useEffect(() => {
    loadSurahIndex().then(setSurahs)
    // Recitation pack paths follow the SELECTED reciter — make sure the registry
    // is applied before any download starts building URLs.
    loadReciters().catch(() => {})
    refresh()
    // Follow the global download-all (keeps working across page changes).
    const un = subscribeAll((s) => {
      setAllProg(s)
      if (!s || (s.done && s.done % 200 === 0)) refresh()
    })
    return un
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleDownload(s) {
    setProgress({ surah: s.num, pct: 0 })
    try {
      await downloadSurah(type, s.num, s.ttlVer, (v, t) => setProgress({ surah: s.num, pct: Math.round((v / t) * 100) }))
    } catch (e) { /* cancelled/unsupported */ }
    setProgress(null)
    refresh()
  }
  async function handleDelete(s) {
    await deleteSurah(type, s.num, s.ttlVer)
    refresh()
  }

  function handleDownloadAll() {
    setAllProg({ done: 0, total: 0, failed: 0 })
    startDownloadAll() // runs globally; safe against double-start
  }

  return (
    <div className="jq-shell jq-page">
      <h1 className="jq-page-title">{t('dlTitle')}</h1>
      <p className="jq-page-sub">{t('dlSub')}</p>

      <div className="jq-storage">
        <div className="jq-storage-row">
          <span>{t('storageUsed')}</span>
          <span>{fmt(storage.usage)}{storage.quota ? ` / ${fmt(storage.quota)}` : ''}</span>
        </div>
        <div className="jq-storage-bar">
          <div style={{ width: storage.quota ? `${Math.min(100, (storage.usage / storage.quota) * 100)}%` : '0%' }} />
        </div>
        <button className="jq-chip jq-danger-chip" onClick={async () => { await deleteAll(); refresh() }}>
          {t('clearAll')}
        </button>
      </div>

      <div className="jq-dl-all">
        <div className="jq-dl-all-head">
          <span className="jq-dl-all-title">{t('allData')}</span>
          <span className="jq-muted">{t('allDataSub')}</span>
        </div>
        {allProg ? (
          <>
            <div className="jq-storage-bar">
              <div style={{ width: allProg.total ? `${(allProg.done / allProg.total) * 100}%` : '0%' }} />
            </div>
            <div className="jq-dl-all-row">
              <span className="jq-muted">
                {allProg.done} / {allProg.total || '…'} {t('files')}
                {allProg.failed ? ` · ${allProg.failed} ${t('failedFiles')}` : ''}
              </span>
              <button className="jq-chip jq-danger-chip" onClick={cancelDownloadAll}>{t('cancel')}</button>
            </div>
          </>
        ) : (
          <button className="jq-chip active" onClick={handleDownloadAll}>⬇ {t('downloadAll')} · ~6 GB</button>
        )}
      </div>

      <div className="jq-controls jq-seg">
        <button className={`jq-chip${type === 'tafsir' ? ' active' : ''}`} onClick={() => setType('tafsir')}>{t('tafsirPack')} · 4.5 GB</button>
        <button className={`jq-chip${type === 'recitation' ? ' active' : ''}`} onClick={() => setType('recitation')}>{t('recitationPack')} · 1.5 GB</button>
      </div>

      <ul className="jq-dl-list">
        {surahs.map((s) => {
          const isDone = done.has(`${type}:${s.num}`)
          const active = progress && progress.surah === s.num
          return (
            <li key={s.num} className="jq-dl-item">
              <span className="jq-surah-num">{s.num}</span>
              <span className="jq-dl-name">{s.nameFa} <small>{s.ttlVer} {t('ayahs')}</small></span>
              {active ? (
                <span className="jq-dl-pct">{progress.pct}%</span>
              ) : isDone ? (
                <button className="jq-chip jq-danger-chip" onClick={() => handleDelete(s)}>{t('delete')}</button>
              ) : (
                <button className="jq-chip active" onClick={() => handleDownload(s)}>{t('download')}</button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
