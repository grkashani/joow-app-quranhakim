import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// Mounted under https://apps.joow.ir/joowquran/web/ in production; served at root in dev.
export default defineConfig(({ command, mode }) => ({
  // Web build stays under /joowquran/web/; the Capacitor build serves from localhost root.
  base: command === 'build' && mode !== 'capacitor' ? '/joowquran/web/' : '/',
  plugins: [react()],
  server: {
    port: 3308,
    proxy: {
      // Audio lives on the quranner.com server; proxy by IP so it works locally
      // even before DNS propagates. Host is forced so nginx matches the vhost.
      '/tafsir': { target: 'https://91.107.131.70', changeOrigin: true, secure: false, headers: { Host: 'quranner.com' } },
      '/recitation': { target: 'https://91.107.131.70', changeOrigin: true, secure: false, headers: { Host: 'quranner.com' } },
      '/transcripts': { target: 'https://91.107.131.70', changeOrigin: true, secure: false, headers: { Host: 'quranner.com' } },
      '/api': { target: 'https://91.107.131.70', changeOrigin: true, secure: false, headers: { Host: 'quranner.com' } },
    },
  },
}))
