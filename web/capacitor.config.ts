import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.joow.quran',
  appName: 'Quran Hakim',
  webDir: 'dist',
  server: {
    // Origin = https://localhost (secure context) so streaming from https://quranner.com
    // is not treated as mixed content. No server.url — the bundled dist/ is loaded.
    androidScheme: 'https',
    iosScheme: 'https',
  },
  android: {
    allowMixedContent: false,
  },
}

export default config
