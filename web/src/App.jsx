import { useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Home from './pages/Home.jsx'
import Reader from './pages/Reader.jsx'
import WordSearch from './pages/WordSearch.jsx'
import QuranGPT from './pages/QuranGPT.jsx'
import Downloads from './pages/Downloads.jsx'
import Profile from './pages/Profile.jsx'
import TabBar from './components/TabBar.jsx'
import TopBar from './components/TopBar.jsx'
import Drawer from './components/Drawer.jsx'
import { LanguageProvider } from './lib/i18n.jsx'
import './App.css'
import '../../joow-app-theme.css'

// Router basename = the deploy base without its trailing slash ('/hakim' for --base=/hakim/,
// undefined at root). Trailing slash stripped so both /hakim and /hakim/ resolve to the app root.
const routerBase = import.meta.env.BASE_URL.replace(/\/$/, '') || undefined

// The app shell (chrome + routes). EMBED MODE — a single shared ayah rendered
// inside a yQuran Social post — strips the TopBar / Drawer / TabBar so only the
// ayah + its player show; the Reader itself detects the :ayah param.
function Shell() {
  const [menuOpen, setMenuOpen] = useState(false)
  const loc = useLocation()
  const embed = loc.pathname.startsWith('/ayah/') || new URLSearchParams(loc.search).get('embed') === '1'
  return (
    <div className={`jq-app${embed ? ' jq-embed' : ''}`}>
      {!embed && <TopBar onMenu={() => setMenuOpen(true)} />}
      {!embed && <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} />}
      <main className="jq-main">
        <Routes>
          <Route path="/" element={<Navigate to="/surah" replace />} />
          <Route path="/surah" element={<Home />} />
          <Route path="/surah/:num" element={<Reader />} />
          {/* One ayah, playable — the shareable interactive unit embedded in Social. */}
          <Route path="/ayah/:num/:ayah" element={<Reader />} />
          <Route path="/word" element={<WordSearch />} />
          <Route path="/gpt" element={<QuranGPT />} />
          <Route path="/downloads" element={<Downloads />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Navigate to="/surah" replace />} />
        </Routes>
      </main>
      {!embed && <TabBar />}
    </div>
  )
}

export default function App() {
  return (
    <LanguageProvider>
      <BrowserRouter basename={routerBase}>
        <Shell />
      </BrowserRouter>
    </LanguageProvider>
  )
}
