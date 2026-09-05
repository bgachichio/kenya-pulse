import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [react(), VitePWA({
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
