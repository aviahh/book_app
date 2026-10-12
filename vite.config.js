import { defineConfig, transformWithOxc } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Text recognition (comics): Tesseract's engine and language models, served
// from Folio itself (never a third-party CDN) under ocr/, downloaded only the
// first time a bubble is read. The engine's loader is rewritten for Safari 12.
const require = createRequire(import.meta.url);
const OCR = [
  ['tesseract.js/dist/worker.min.js', 'ocr/worker.min.js', true],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'ocr/core/tesseract-core-lstm.wasm.js', true],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'ocr/core/tesseract-core-simd-lstm.wasm.js', true],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js', true],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'ocr/lang/eng.traineddata.gz', false],
  ['@tesseract.js-data/jpn/4.0.0_best_int/jpn.traineddata.gz', 'ocr/lang/jpn.traineddata.gz', false],
  ['@tesseract.js-data/jpn_vert/4.0.0_best_int/jpn_vert.traineddata.gz', 'ocr/lang/jpn_vert.traineddata.gz', false],
];
async function ocrFile([from, , script]) {
  const path = require.resolve(from);
  if (!script) return readFileSync(path);
  const out = (await transformWithOxc(readFileSync(path, 'utf8'), 'ocr.js', { target: 'safari12', lang: 'js', sourcemap: false, helpers: { mode: 'External' } })).code;
  // The one helper these need, defined in the file itself (a worker script can't import one).
  const used = out.indexOf('babelHelpers.') >= 0;
  if (used && /babelHelpers[.](?!defineProperty[^A-Za-z0-9_$])[A-Za-z_$]/.test(out)) throw new Error(`OCR asset ${from} needs more helpers`);
  return used ? `var babelHelpers = { defineProperty: function (o, k, v) { Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true, writable: true }); return o; } };
${out}` : out;
}
function ocrAssets() {
  return {
    name: 'folio-ocr-assets',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const f = OCR.find((x) => (req.url || '').split('?')[0].endsWith('/' + x[1]));
        if (!f) return next();
        try {
          const body = await ocrFile(f);
          res.setHeader('Content-Type', f[2] ? 'text/javascript' : 'application/gzip');
          res.end(body);
        } catch (e) {
          next(e);
        }
      });
    },
    async generateBundle() {
      for (const f of OCR) this.emitFile({ type: 'asset', fileName: f[1], source: await ocrFile(f) });
    },
  };
}

export default defineConfig({
  base: './',
  // Shown in Settings, so it's easy to tell whether the device has the latest version.
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // While developing, the voice relay (/api/tts) is the deployed one.
  server: {
    proxy: { '/api': { target: 'https://folio-r7k2xq9m.aviahh.workers.dev', changeOrigin: true } },
  },
  build: {
    // Old iPads stay on iOS 12 (Safari 12): compile syntax down for it, and
    // make the CSS output understandable to it as well.
    target: ['safari12', 'ios12', 'chrome64', 'firefox67', 'edge79'],
    cssTarget: ['safari12', 'ios12', 'chrome64', 'firefox67', 'edge79'],
  },
  plugins: [
    ocrAssets(),
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
        navigateFallbackDenylist: [/^\/api\//, /privacy\.html$/],
        // Text recognition is large and optional: kept once first used, not downloaded with the app.
        globIgnores: ['ocr/**'],
        runtimeCaching: [{ urlPattern: /\/ocr\//, handler: 'CacheFirst', options: { cacheName: 'folio-ocr', expiration: { maxEntries: 12 } } }],
      },
    }),
  ],
});
