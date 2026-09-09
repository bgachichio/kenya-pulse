import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/* A font isn't visible the moment its <link> stylesheet loads - the browser
   only starts fetching a @font-face's file once it discovers that rule while
   parsing CSS, which is well after the first paint. That gap is the lag: the
   page opens in a fallback face and swaps mid-read.

   Fontsource ships nine files split by subset (Cyrillic, Greek, Vietnamese,
   Latin, Latin Extended...) so every character in this English-language app
   comes from the "latin" file alone - confirmed against the punctuation the
   app actually uses (middle dot, en/em dash, ellipsis, arrows, minus sign).
   Preloading just those two - one per family - starts the fetch in parallel
   with the HTML itself, so the swap is done before anyone would notice it. */
function preloadCriticalFonts() {
  return {
    name: 'preload-critical-fonts',
    transformIndexHtml: {
      order: 'post',
      handler(html, { bundle }) {
        if (!bundle) return html
        const pick = needle => Object.keys(bundle)
          .find(f => f.includes(needle) && f.endsWith('.woff2'))
        const files = [
          pick('inter-latin-wght-normal'),
          pick('courier-prime-latin-400-normal'),
        ].filter(Boolean)
        const links = files
          .map(f => `  <link rel="preload" href="/${f}" as="font" type="font/woff2" crossorigin>`)
          .join('\n')
        return links ? html.replace('</head>', `${links}\n  </head>`) : html
      }
    }
  }
}

export default defineConfig({
  plugins: [react(), preloadCriticalFonts(), VitePWA({
    /* injectManifest, not generateSW: the push and notification-tap handlers
       live in src/sw.js and a generated worker has nowhere to put them. */
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.js',
    registerType: 'autoUpdate',
    injectRegister: 'auto',
    includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
      'icon-maskable-512.png'],
    injectManifest: {
      globPatterns: ['**/*.{js,css,html,png,svg}'],
    },
    manifest: {
      name: 'Kenya Pulse',
      short_name: 'Kenya Pulse',
      description: 'The Kenyan economy at a glance, and where money is being paid',
      // The two colours the OS paints before a single token has loaded, so
      // they are the only place a hex may be written outside index.css.
      // theme_color is --md-primary; background_color is --md-surface in
      // light, the colour the page itself paints - it was an iOS system
      // grey, which flashed a colour the app never uses.
      theme_color: '#237352',
      background_color: '#F7FAF8',
      display: 'standalone',
      orientation: 'portrait',
      start_url: '/',
      scope: '/',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    }
  })]
})
