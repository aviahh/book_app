import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  // Shown in Settings, so it's easy to tell whether the device has the latest version.
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    // Old iPads stay on iOS 12 (Safari 12): compile syntax down for it, and
    // make the CSS output understandable to it as well.
    target: ['safari12', 'ios12', 'chrome64', 'firefox67', 'edge79'],
    cssTarget: ['safari12', 'ios12', 'chrome64', 'firefox67', 'edge79'],
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'Folio',
        short_name: 'Folio',
        description: 'A calm, elegant reader for your books.',
        theme_color: '#14120f',
        background_color: '#14120f',
        display: 'fullscreen',
        orientation: 'any',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,png,svg,woff2,bcmap,pfb,ttf,wasm}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
});
