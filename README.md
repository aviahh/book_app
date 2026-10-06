# Folio — a calm reader for your books

An installable web app (PWA) for reading PDF books on tablets and iPads.
It runs in Safari/Chrome, can be added to the home screen, and then opens
full-screen and works offline like a native app.

## Run it

```bash
npm install
npm run dev
```

`npm run dev` prints a **Network** address (e.g. `http://192.168.1.20:5173`).
Open it on a tablet on the same Wi-Fi to try it out.

## Install on an iPad / tablet

Offline use and "Add to Home Screen" as a real app need HTTPS. Build and host
the `dist/` folder on any static host (GitHub Pages, Netlify, Cloudflare Pages…):

```bash
npm run build
```

Then on the iPad open the site in Safari → Share → **Add to Home Screen**.

## What's inside

| Screen | |
|---|---|
| **Reading Room** (home) | Continue-reading card with progress, reading rhythm (today, streak, this week), recently opened and new books. |
| **Library** | Cover grid, search, sort (recent / title / author), add books from Files / iCloud / Downloads (or drag & drop on a computer), mark finished, remove. |
| **Reader** | Landscape: cover alone, then two-page spreads with a spine gradient and a realistic page curl (swipe from the page edge). Portrait: pages scroll vertically. Pinch to zoom and drag to pan in both; full screen while reading; fading side arrows (tap to reveal, tap again to turn — or single-tap mode in Settings); auto-hiding toolbar. |
| **Toolbar** | Thumbnails strip · first / −N / −1 · page indicator (tap to type a page) · +1 / +N / last · read aloud · orientation lock. |
| **Words** | Double-tap a word → translation bubble with pronunciation and copy (Google Translate). |
| **Read aloud** | Tap the speaker, drag across text; Google's voice starts streaming immediately; pause / resume / stop. |
| **Settings** | Arrow tap behaviour, jump size, page-turn effect, toolbar position, hide delay, page tone (original / warm / night), surroundings, translation and speech languages. |

Books are stored privately in the browser's storage on the device (IndexedDB).
Translation and read-aloud need an internet connection; read-aloud falls back to
the device's built-in voice when Google can't be reached.

## Code map

- `src/reader/reader.js` — reading view: layout, gestures, toolbar, translation, read-aloud
- `src/reader/flipper.js` — the 3D page-turn
- `src/reader/spreads.js` — page ↔ spread maths (cover alone, pairs, back cover)
- `src/reader/textTools.js` — word / selection hit-testing on the PDF text layer
- `src/reader/orientation.js` — orientation lock (native API or CSS counter-rotation on iPad)
- `src/google.js` — translation + chunked streaming speech (same Google endpoints as EZ_shortcut)
- `src/views/` — Reading Room, Library, Settings
- `reference/` — the design reference images
- `samples/` — a generated sample PDF for testing
