import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['icon-192.png', 'icon-512.png'],
    manifest: {
      name: 'Kenya Pulse',
      short_name: 'Pulse',
      description: 'The Kenyan economy at a glance, and where money is being paid',
      theme_color: '#237352',
      background_color: '#FAF8F4',
      display: 'standalone',
      orientation: 'portrait',
      start_url: '/',
      scope: '/',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,png,svg}'],
      runtimeCaching: [{
        urlPattern: /^https:\/\/gachichio\.org\/pulse\/.*\.json$/,
        handler: 'NetworkFirst',
        options: {
          cacheName: 'pulse-data',
          networkTimeoutSeconds: 6,
          expiration: { maxEntries: 10, maxAgeSeconds: 2592000 },
          cacheableResponse: { statuses: [0, 200] }
        }
      }]
    }
  })]
})
