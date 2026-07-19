import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { execSync } from 'node:child_process'

// Build stamp shown on the Home hero + Menu About — lets anyone confirm at a
// glance that their device is on the latest deploy (stale PWA caches happen).
let sha = ''
try { sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { /* not a git checkout */ }
const buildStamp = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC${sha ? ` · ${sha}` : ''}`

// Mounted under https://apps.joow.ir/joowquran/web/ in production; served at root in dev.
export default defineConfig(({ command, mode }) => ({
  // Web build stays under /joowquran/web/; the Capacitor build serves from localhost root.
  base: command === 'build' && mode !== 'capacitor' ? '/joowquran/web/' : '/',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(buildStamp),
  },
  server: {
    port: 3308,
    proxy: Object.fromEntries(
      // Audio + API live on the quranner.com server; proxy by IP so it works
      // locally even before DNS propagates. Host is forced so nginx matches the
      // vhost. Everything is served from the server's static caches (get-or-create)
      // — for Fatiha all clips already exist, so local dev never re-bills ElevenLabs.
      ['/tafsir', '/tafsir-short', '/tafsir-tts', '/meaning-tts', '/recitation', '/recitation-timings', '/reciters', '/transcripts', '/api'].map((p) => [
        p,
        { target: 'https://91.107.131.70', changeOrigin: true, secure: false, headers: { Host: 'quranner.com' } },
      ])
    ),
  },
}))
