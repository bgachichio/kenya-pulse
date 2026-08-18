# Kenya Pulse — mobile and PWA

Two jobs: ship the responsive build, then make it installable.

---

## 1 · Update the app

On the Lenovo:

```bash
cd ~/kenya-pulse/kenya-pulse-app
cp ~/Downloads/files/KenyaPulse.jsx src/App.jsx
wc -l src/App.jsx
```

Want **1,399 lines**. Download the new `KenyaPulse.jsx` from the file card first
if you haven't.

---

## 2 · Make it installable

```bash
cat > vite.config.js << 'EOF'
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
      categories: ['finance', 'productivity'],
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
          expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 30 },
          cacheableResponse: { statuses: [0, 200] }
        }
      }]
    }
  })]
})
EOF
```

`NetworkFirst` with a 6-second timeout: the app tries the live feed, and falls
back to the last copy it saw if the network is slow or absent. It works in a lift
and on a plane.

---

## 3 · The icon

```bash
cat > icon.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="512" height="512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#2E8C64"/><stop offset="58%" stop-color="#237352"/>
    <stop offset="100%" stop-color="#B0642A"/></linearGradient></defs>
  <rect width="48" height="48" rx="13" fill="url(#g)"/>
  <path d="M7 27h6.5l3.6-11 5.4 20 4.6-15 3.2 8.5h11" fill="none" stroke="#fff"
    stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="38.5" cy="29.5" r="2.9" fill="#fff"/>
</svg>
EOF

sudo apt install -y librsvg2-bin
rsvg-convert -w 512 -h 512 icon.svg -o public/icon-512.png
rsvg-convert -w 192 -h 192 icon.svg -o public/icon-192.png
ls -l public/icon-*.png
```

No `rsvg-convert`? ImageMagick works too:

```bash
sudo apt install -y imagemagick
convert -background none icon.svg -resize 512x512 public/icon-512.png
convert -background none icon.svg -resize 192x192 public/icon-192.png
```

---

## 4 · Ship it

```bash
npm run build
npx vercel --prod
```

The build output should now list a `sw.js` and a `manifest.webmanifest`
alongside the JS and CSS. That is the PWA machinery.

---

## 5 · Install on the Pixel

1. Open **https://kenya-pulse-app.vercel.app** in Chrome.
2. Wait a few seconds — Chrome checks the manifest and service worker before
   offering to install.
3. Three dots → **Install app**. If you only see *Add to Home screen*, the
   manifest has not been picked up: pull down to refresh and try again.
4. Open it from the home screen. No browser bar, own icon, own window.
5. **⚙** → paste `https://gachichio.org/pulse/data.json` → **Data** →
   **Sync now**.

**Check it holds:** turn on aeroplane mode and reopen. The app should still
load and show the last synced figures. That is the service worker doing its job.

---

## What changed on mobile

The tab strip stays. Five views you switch between constantly should not cost an
extra tap and a hidden menu, so instead of hiding the navigation I made it fit.

| | |
|---|---|
| **Tab labels** | `clamp(11px, 3.3vw, 15px)` — sized off the viewport, so the text-size setting can never overflow the nav |
| **Sparklines** | 88px on desktop, 52px under 440px, hidden under 360px |
| **Indicator labels** | wrap to two lines on mobile instead of being cut with an ellipsis |
| **Pinned block** | two columns, dropping to one under 360px |
| **Outlook charts** | value labels hidden under 360px where they would collide |
| **Page padding** | 14px down to 10px, recovering 8px of usable width |
| **Settings sheet** | respects `env(safe-area-inset-bottom)`, so nothing sits under the gesture bar |
| **Overflow** | `overflow-x: hidden` on the page — a dashboard that scrolls sideways on a phone is one you stop opening |

### Measured, not guessed

The worst case is the label *Outlook* at the narrowest width in use:

| Viewport | Space per tab | Needed | Headroom |
|---|---|---|---|
| 320px | 58px | 47px | 11px |
| 360px | 66px | 50px | 16px |
| 390px | 72px | 54px | 18px |
| 412px (Pixel 9 Pro) | 77px | 57px | 20px |
| 768px | 146px | 65px | 81px |

The component was then mounted at each of those widths and all five tabs were
opened, with no overflow and nothing hard-coded wider than the viewport.

---

Made with ❤️ by [Brian Gachichio](https://gachichio.org)
