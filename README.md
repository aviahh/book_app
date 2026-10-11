# Folio — a calm reader for your books

An installable web app (PWA) for reading PDF, EPUB and comic (CBZ, CBR) books on tablets, iPads and phones.
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
| **Library** | Cover grid, search, sort (recent / title / author), add books from Files / iCloud / Downloads (or drag & drop on a computer), mark finished, remove. Books of a series ("Vol. 3", "Book 3", "#3" …) are stacked on one shelf, volumes in order; any book can be put in a series by hand. The Reading Room offers the next volume after you finish one. |
| **Reader** | Landscape: cover alone, then two-page spreads with a spine gradient and a realistic page curl (swipe from the page edge). Portrait: pages scroll vertically. Pinch to zoom and drag to pan in both; full screen while reading; fading side arrows (tap to reveal, tap again to turn — or single-tap mode in Settings); auto-hiding toolbar. |
| **Toolbar** | Thumbnails strip · first / −N / −1 · page indicator (tap to type a page) · +1 / +N / last · read aloud · orientation lock. |
| **Tools bubble** | A see-through floating button you can drag anywhere (it snaps to the nearer side). Tap: your favorite tools — Search, Bookmark page, Mark where I stopped, Bookmarks, Read aloud, Contents by default — and **More** for the rest (page overview, go to page, page tone, rotation lock, full screen, settings). Press and hold: choose and reorder the favorites. Can be turned off in Settings. |
| **Search** | Finds words or phrases anywhere in the book, with the surrounding text. A result opens its page at the same zoom with the match briefly marked. On a wide screen the results stay open beside the book; on a phone they shrink to a small bar with ‹ › to step through matches. |
| **The way back** | After any jump (search, contents, bookmarks, go to page, thumbnails, first/last) a **Back to page N** button returns to the exact spot and zoom. It shows while Search is open and for a few seconds after a jump or after Search closes (a tap anywhere outside closes Search). |
| **Bookmarks** | **Reading position** (gold ribbon) follows the page you're reading — in a zoomed spread, the page filling the screen — and stays put while you look something up: then a hollow ribbon marked “p. 74” shows where it is — tap it to go back, hold it to read from here. Two page turns forward from where you landed move the reading position there (the ribbon fills in). It stays on screen when zoomed in (see-through); press and hold the solid ribbon to mark the line where you stopped. **Where I stopped** marks an exact line (a flag in the margin; going back highlights the line, or the marked spot if no line was recorded). “Where I stopped” can be removed from the Bookmarks list. Ordinary bookmarks (red ribbon) can carry a short note. All kept in backups. |
| **EPUB books** | Set into real book pages for the device's screen (Literata, Sans or Classic font; text size; line spacing — from **Text** in the tools bubble or in Settings): justified and hyphenated (English), chapter headings kept with their text, pictures and full-page illustrations, footnote links (with the way back), right-to-left paragraphs. Everything that works on PDFs works the same: page turns, zoom, translation, read-aloud, search, bookmarks, contents. Changing the text keeps your place, bookmarks and marks. |
| **Comics & manga** | CBZ and CBR files (ComicInfo.xml read for title, series, volume and manga direction). **Reading mode** in the tools bubble, kept per book: left to right, or right to left for manga (pages, swipes, arrows and keys all run the other way); pages, or one seamless vertical scroll for webtoons (detected from tall pictures). Two-page artwork is shown across both pages of the spread. Folders inside the archive become the contents. |
| **Contents** | The book's table of contents, current chapter marked, tap to jump. |
| **Words** | Press and hold a word → translation bubble with pronunciation and copy (Google Translate). Double-tap zooms in, and double-tap again zooms back out. |
| **Read aloud** | Tap the speaker and drag across a passage to hear it. Switch on **Continuous** in the bar to tap a word instead and read on from there — sentence by sentence, highlighted, turning pages by itself (the screen stays on). The Microsoft voice plays gaplessly: sentences are fetched and decoded ahead and joined on the audio clock. Pause / back a sentence / stop. |
| **Settings** | Arrow tap behaviour, jump size, page-turn effect, toolbar position, hide delay, page tone (original / warm / night), surroundings, translation and speech languages. |

Books are stored privately in the browser's storage on the device (IndexedDB).
Translation and read-aloud need an internet connection; read-aloud falls back to
the device's built-in voice when Google can't be reached.

## Code map

- `src/reader/reader.js` — reading view: layout, gestures, toolbar, translation, read-aloud
- `src/reader/flipper.js` — the 3D page-turn
- `src/reader/spreads.js` — page ↔ spread maths (cover alone, pairs, back cover)
- `src/reader/textTools.js` — word / selection hit-testing on the PDF text layer
- `src/comic/comic.js` — comics: archives (zip; rar via a small WebAssembly unrar, loaded only for CBR), pages, two-page artwork, right-to-left drawing
- `src/epub/` — EPUB books: unzip and read the package (`epub.js`), typeset into pages (`layout.js`), and present the pages to the reader like a PDF document (`doc.js`)
- `src/reader/orientation.js` — orientation lock (native API or CSS counter-rotation on iPad)
- `src/google.js` — translation + chunked streaming speech (same Google endpoints as EZ_shortcut)
- `src/views/` — Reading Room, Library, Settings
- `reference/` — the design reference images
- `samples/` — a generated sample PDF for testing

## Sync (optional)

Settings › Sync. Without an account nothing changes: Folio works fully on the device, offline.

- **Across your devices:** reading place, bookmarks with notes, "Where I stopped", series, settings and reading time. Sign in with Google, or **Link a device** with a 6-character code from a device that is already signed in (handy on the iOS 12 home-screen app). Each item merges on its own; the newer change wins; removals reach the other devices. Books match by their content, whatever the file is called; EPUB places travel as the text they point at, since pages differ per screen. An open book never jumps: a newer place shows as **Continue at p. N**.
- **Library in your own Google Drive:** a "Folio" folder in your Drive is the library. Put books there any way you like (copy from a computer, upload from a phone, add them in Folio) and every device shows them; Folio recognises each file by its content and never makes a second copy. Books added in Folio go up into the folder. Delete a file there (or move it out) and it leaves every device. Other devices show books with a small cloud mark and download one when you open it. **Remove download** frees the space on one device and keeps the book and your progress. Folio asks for access to the whole Drive (Google shows an "unverified app" notice once) because it must see files it didn't put there, but it only works inside its folder.
- **Family library:** **Share** gives a code; whoever adds it can read the books in your Drive (streamed from it, never copied to their Drive), with their own progress.

Code: `src/sync/` (engine, items, Drive, family, Settings section) and `worker/sync.js` (accounts, `/api/sync`, Drive grant, family). Data lives in Cloudflare D1, one row per item.

### One-time setup (Cloudflare and Google)

1. Create the database and put its id in `wrangler.jsonc` (`d1_databases[0].database_id`):
   `npx wrangler d1 create folio-sync`. The Worker creates its tables itself.
2. Google Cloud Console: a project with the **Google Drive API** enabled; OAuth consent screen (External, scopes `openid`, `email`, `drive`), **published** (In production; unverified is fine for personal use, under 100 users); an OAuth client of type **Web application** with the redirect URI `https://<your-worker>/api/auth/google/callback`.
3. Worker secrets (Cloudflare dashboard › the Worker › Settings › Variables and Secrets): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_KEY` (any long random string; it encrypts the stored Drive access).

Local testing: `.dev.vars` with `DEV_LOGIN=1` enables `/api/auth/dev?email=…` (sign in without Google) and a stand-in Drive grant, on localhost only.
