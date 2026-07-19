import { useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
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

const routerBase = import.meta.env.BASE_URL === '/' ? undefined : import.meta.env.BASE_URL

export default function App() {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <LanguageProvider>
      <BrowserRouter basename={routerBase}>
        <div className="jq-app">
          <TopBar onMenu={() => setMenuOpen(true)} />
          <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} />
          <main className="jq-main">
            <Routes>
              <Route path="/" element={<Navigate to="/surah" replace />} />
              <Route path="/surah" element={<Home />} />
              <Route path="/surah/:num" element={<Reader />} />
              <Route path="/word" element={<WordSearch />} />
              <Route path="/gpt" element={<QuranGPT />} />
              <Route path="/downloads" element={<Downloads />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="*" element={<Navigate to="/surah" replace />} />
            </Routes>
          </main>
          <TabBar />
        </div>
      </BrowserRouter>
    </LanguageProvider>
  )
}
