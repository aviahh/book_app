// The reading view: layout, navigation, page turning, zoom & pan, toolbar,
// thumbnails, word translation, read-aloud selection and the orientation lock.
//
// Landscape ("double"): a book of facing pages, turned like paper.
// Portrait ("single"): pages stacked in a vertical strip and scrolled.
// Both can be pinch-zoomed and panned.
import { getBook, getBookFile, updateBook } from '../db.js';
import { openPdf, buildTextLayer, renderPageCanvas, releaseCanvas, canvasOk, ZOOM_PIXELS, LOW_MEMORY } from '../pdf.js';
import { getSettings, onSettingsChange, setSetting } from '../settings.js';
import { icons } from '../icons.js';
import { Speech, translate, pronounce, stopPronounce, guessLang, isRtl } from '../google.js';
import { trackReading } from '../stats.js';
import { PageCache } from './pageCache.js';
import { FoldFlipper } from './foldFlipper.js';
import { BendFlipper } from './bendFlipper.js';
import { Camera } from './camera.js';
import { spreadCount, spreadOf, spreadPages, visiblePages, spreadLabel } from './spreads.js';
import { collectSpans, hitTest, wordAt, selectableAt, rangeRects, rangeText, pageText, sentenceRanges } from './textTools.js';
import { OrientationLock } from './orientation.js';
import { ThumbStrip } from './thumbs.js';
import { ReaderTools } from './tools.js';
import { onRemoteBook } from '../sync/index.js';

const TAP_MS = 300;
const DOUBLE_TAP_MS = 340;
const MOVE_SLOP = 10;
// The book open when the app last went to the background (see main.js).
export const READING_KEY = 'folio.reading.v1';
// Set while that book is being opened again at start; cleared once it has opened (see main.js).
export const REOPENING_KEY = 'folio.reopening.v1';
// Text positions { index, offset } (span, character): order and equality.
const before = (p, q) => p.index < q.index || (p.index === q.index && p.offset < q.offset);
const same = (p, q) => p.index === q.index && p.offset === q.offset;

/**
 * The lines of a page's text as shown, in reading order: the first and last letter of each
 * (in the page text) and where it is on screen now.
 */
function linesOf({ spans, map }) {
  const first = new Map();
  const last = new Map();
  for (let k = 0; k < map.length; k++) {
    const m = map[k];
    if (!m) continue;
    if (!first.has(m.index)) first.set(m.index, k);
    last.set(m.index, k);
  }
  const lines = [];
  let cur = null;
  for (const [i, a] of first) {
    const r = spans[i].getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (cur && Math.abs(r.top - cur.top0) <= Math.min(r.height, cur.h) * 0.5) {
      cur.b = last.get(i);
      cur.left = Math.min(cur.left, r.left);
      cur.right = Math.max(cur.right, r.right);
      cur.top = Math.min(cur.top, r.top);
      cur.bottom = Math.max(cur.bottom, r.bottom);
    } else {
      lines.push((cur = { a, b: last.get(i), left: r.left, right: r.right, top: r.top, bottom: r.bottom, top0: r.top, h: r.height }));
    }
  }
  return lines;
}
const LONG_PRESS_MS = 450; // press and hold a word: translate it
const READ_ON_TURNS = 2; // after a jump, this many page turns forward make that place your reading position
const DOUBLE_TAP_ZOOM = 2.2; // where a double tap zooms to (when not going to one page)
const MAX_ZOOM = 4;
const SYSTEM_EDGE = 28; // px at the top and bottom of the screen: where the system's own swipes begin
const SWIPE_TURN_ZOOM = 1.35; // landscape: zoomed in up to this, a sideways swipe still turns the page
const STRIP_GAP = 14;
// One page when zoomed in (landscape): zooming out stops where the page is
// as wide as the screen; past that it resists (FOCUS_GIVE: how much of the
// pinch gets through), and letting go below FOCUS_EXIT of that width returns
// to the spread. FOCUS_MS: how long the move takes.
const FOCUS_EXIT = 0.9;
const FOCUS_GIVE = 0.55;
const FOCUS_MS = 300;
const STRIP_PAD = 18;
// Animated page-turn styles (landscape) → their engines.
const TURNERS = { fold: FoldFlipper, bend: BendFlipper };

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;

// Opened from the home-screen icon, the app already runs full screen. Asking
// for full screen again would only make Chrome show its "swipe to exit" notice.
const appIsFullscreen = () => matchMedia('(display-mode: fullscreen)').matches;

function enterFullscreen() {
  if (appIsFullscreen()) return;
  const d = document.documentElement;
  const req = d.requestFullscreen || d.webkitRequestFullscreen;
  if (fsElement() || !req) return;
  try {
    req.call(d, { navigationUI: 'hide' })?.catch?.(() => {});
  } catch {}
}

function exitFullscreen() {
  if (!fsElement()) return;
  try {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document)?.catch?.(() => {});
  } catch {}
}

export async function mountReader(root, { id }, nav) {
  // Ask for full screen right away, while the tap that opened the book still counts as a gesture.
  if (getSettings().fullscreen) enterFullscreen();
  // If opening takes long, say so and offer a way back.
  const wait = document.createElement('div');
  wait.className = 'typeset-veil reader-wait';
  wait.innerHTML = '<div class="tv-card"><div class="spinner"></div><p>Opening the book…</p><a class="btn subtle" href="#/">Back to the Reading Room</a></div>';
  const slow = setTimeout(() => root.append(wait), 5000);
  try {
    const close = await openReader(root, id, nav);
    // It opened: if the app is closed from here on, it may open this book again at start.
    const opened = setTimeout(() => {
      try {
        localStorage.removeItem(REOPENING_KEY);
      } catch (e) {}
    }, 3000);
    return () => {
      clearTimeout(opened);
      if (close) close();
    };
  } finally {
    clearTimeout(slow);
    wait.remove();
  }
}

async function openReader(root, id, nav) {
  let book = await getBook(id);
  if (!book) return nav('#/library');
  const blob = await getBookFile(id);
  if (book.format === 'epub') return mountEpub(root, book, blob, nav);
  if (book.format === 'comic') return mountComic(root, book, blob, nav);
  const doc = await openPdf(new Uint8Array(await blob.arrayBuffer()));
  // Size the pages from an inside page: the cover is often a slightly
  // different shape, and every page is drawn into the same box.
  try {
    const vp = (await doc.getPage(Math.max(1, Math.ceil(doc.numPages / 2)))).getViewport({ scale: 1 });
    book.pageAspect = vp.width / vp.height;
  } catch {}
  const reader = new Reader(root, book, doc, nav);
  return () => reader.destroy();
}

/**
 * Comics and manga. Changing the reading direction or view rebuilds the
 * pages (two-page artwork is split differently), keeping the place.
 */
async function mountComic(root, book, blob, nav) {
  const { openComicBook, comicPages } = await import('../comic/comic.js');
  let reader = null;
  let gone = false;
  const open = async (reopen) => {
    const doc = await openComicBook(book, blob);
    if (gone) return doc.destroy();
    book.pageAspect = doc.W / doc.H;
    if (book.pageCount !== doc.numPages) {
      book.pageCount = doc.numPages;
      updateBook(book.id, { pageCount: doc.numPages });
    }
    reader = new Reader(root, book, doc, nav, { reopen, onComic: change });
  };
  const change = async (patch) => {
    if (gone || !reader) return;
    const old = reader.doc;
    const keep = reader.handOver();
    reader.destroy({ staying: true });
    reader = null;
    book = Object.assign((await getBook(book.id)) || book, keep.saved);
    const comic = Object.assign({}, book.comic, patch);
    // Same pictures, maybe cut differently: move every saved page to the page now showing the same picture.
    const pages = comicPages(old.comic, { rtl: comic.rtl, view: comic.view });
    const map = (n) => {
      if (!n) return n;
      const was = old.pages[Math.min(Math.max(1, n), old.pages.length) - 1];
      const i = pages.findIndex((p) => p.img === was.img && (was.half < 0 || p.half < 0 || p.half === was.half));
      return i >= 0 ? i + 1 : Math.min(n, pages.length);
    };
    const saved = { comic, pageCount: pages.length, lastPage: map(book.lastPage), readingPos: map(book.readingPos) };
    if (Array.isArray(book.bookmarks)) saved.bookmarks = book.bookmarks.map((b) => Object.assign({}, b, { page: map(b.page) }));
    if (book.stopMark) saved.stopMark = Object.assign({}, book.stopMark, { page: map(book.stopMark.page) });
    Object.assign(book, saved);
    await updateBook(book.id, saved);
    await open(keep.panel);
  };
  await open();
  return () => {
    gone = true;
    if (reader) reader.destroy();
  };
}

const EPUB_KEYS = ['epubFont', 'epubSize', 'epubSpacing'];

/**
 * EPUB books are typeset into pages for this screen and the text settings.
 * Changing those sets the pages again and reopens the book at the same text.
 */
async function mountEpub(root, book, blob, nav) {
  const { openEpubBook } = await import('../epub/index.js');
  let reader = null;
  let gone = false;
  let busy = null;
  const veil = document.createElement('div');
  veil.className = 'typeset-veil';
  veil.innerHTML = '<div class="tv-card"><div class="spinner"></div><p>Setting the pages…</p></div>';
  const open = async (reopen) => {
    const showSoon = setTimeout(() => root.append(veil), reopen ? 0 : 250);
    const label = veil.querySelector('p');
    try {
      const { doc } = await openEpubBook(book, blob, (f) => (label.textContent = f < 1 && f > 0 ? `Setting the pages… ${Math.round(f * 100)}%` : 'Setting the pages…'), (patch) => updateBook(book.id, patch));
      if (gone) return doc.destroy();
      book.pageAspect = doc.layout.W / doc.layout.H;
      reader = new Reader(root, book, doc, nav, { reopen });
    } finally {
      clearTimeout(showSoon);
      veil.remove();
    }
  };
  await open();
  let timer = 0;
  const off = onSettingsChange((s, key) => {
    if (!EPUB_KEYS.includes(key) || gone) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (busy) await busy;
      if (gone || !reader) return;
      const keep = reader.handOver();
      reader.destroy({ staying: true });
      reader = null;
      book = Object.assign((await getBook(book.id)) || book, keep.saved);
      busy = open(keep.panel).catch((e) => console.error(e));
      await busy;
      busy = null;
    }, 450);
  });
  return () => {
    gone = true;
    off();
    clearTimeout(timer);
    if (reader) reader.destroy();
  };
}

class Reader {
  constructor(root, book, doc, nav, { reopen, onComic } = {}) {
    this.root = root;
    this.reflowable = !!doc.reflowable;
    this.kind = doc.reflowable ? 'epub' : doc.fixedImages ? 'comic' : 'pdf';
    this.onComic = onComic;
    // Manga: the page area is mirrored on screen (its pages are drawn mirrored, so they read right).
    this.rtl = !!doc.rtl;
    // Webtoons: one long vertical scroll, pictures at their own heights, no gaps.
    this.webtoon = doc.view === 'scroll';
    this.book = book;
    this.doc = doc;
    this.nav = nav;
    this.total = doc.numPages;
    this.cache = new PageCache(doc);
    this.cache.setTone(getSettings().pageTone);
    this.settings = getSettings();
    this.mode = null;
    this.focus = false; // landscape, zoomed into one page
    this.spread = 0; // spread index (double) or page index (single)
    this.busy = false; // a page turn is animating
    this.renderZoom = 1;
    this.hiResToken = 0;
    this.pointers = new Map();
    this.stripPages = new Map();
    this.cleanups = [];
    this.speech = new Speech({ onState: (s) => this.#onSpeechState(s), onPiece: (i) => this.#onPiece(i), voice: () => this.settings.speechVoice });
    this.#build();
    this.camera = new Camera(this.cameraEl, () => this.#onCamera());
    this.lock = new OrientationLock(this.el, () => this.#layout());
    this.thumbs = new ThumbStrip(this.el.querySelector('.thumbstrip'), doc, {
      label: () => this.#label(),
      mode: () => this.mode,
      current: () => this.spread,
      go: (i) => this.#jumpTo(visiblePages(spreadPages(this.mode, i, this.total))[0]),
    });
    this.thumbs.cache.setTone(this.settings.pageTone);
    this.#bindInput();
    this.#bindRibbon();
    this.chaptersReady = this.#loadChapters();
    this.tools = new ReaderTools({
      el: this.el,
      doc,
      book,
      total: this.total,
      currentPage: () => this.#currentPage(),
      root: this.root,
      goToPage: (n, opts) => this.#jumpTo(n, opts),
      readingPos: () => this.readingPos,
      stopMark: () => this.book.stopMark || null,
      isAway: () => this.#away(),
      placeStopMark: () => this.#startPlacing(),
      goToStop: () => this.#goToStop(),
      clearStopMark: async () => {
        this.book.stopMark = null;
        await updateBook(this.book.id, { stopMark: null });
        this.tools.decorateAll();
      },
      searchClosed: () => {
        this.returnShowUntil = Date.now() + this.#returnMs();
        this.#syncReturn();
      },
      dock: (px) => {
        this.keepZoom = true;
        this.dockPx = px || 0;
        this.el.style.right = px ? `${px}px` : '';
      },
      outline: () => this.chaptersReady.then(() => this.outlineItems || []),
      toast: (m) => this.#toast(m),
      isReading: () => !!this.readMode,
      reflowable: this.reflowable,
      kind: this.kind,
      comicMode: () => ({ rtl: this.rtl, bubblesRtl: this.#bubblesRtl(), view: this.webtoon ? 'scroll' : 'pages' }),
      setComicMode: (patch) => (patch.bubbles ? this.#setBubbleOrder(patch.bubbles) : this.onComic && this.onComic(patch)),
      toolbar: (act) => {
        const btn = this.el.querySelector(`[data-act="${act}"]`);
        if (act === 'goto' || act === 'thumbs') this.#showChrome();
        this.#action(act, btn);
      },
    });
    if (reopen === 'text') this.tools.run('text');
    // Keep the page itself still while reading (iOS likes to scroll/zoom it).
    document.documentElement.classList.add('reading');
    window.scrollTo(0, 0);
    this.cleanups.push(onSettingsChange((s) => this.#applySettings(s)));
    this.cleanups.push(trackReading(() => !document.hidden));
    // Changes from your other devices (sync): bookmarks and marks follow at once; a newer place is offered, never forced.
    this.cleanups.push(onRemoteBook((id, patch, info) => id === this.book.id && this.#remoteChange(patch, info)));
    this.#applySettings(this.settings);
    this.startPage = Math.min(book.lastPage || 1, this.total);
    // The reading position: the page being read, kept in place while you look
    // something up elsewhere in the book (a jump), until you read on there.
    this.readingPos = Math.min(book.readingPos || book.lastPage || 1, this.total);
    try {
      const open = JSON.parse(localStorage.getItem(READING_KEY) || 'null');
      if (open && open.id === book.id && open.view && Date.now() - open.at < 12 * 3600 * 1000) {
        this.pendingView = open.view;
        this.startPage = Math.min(Math.max(1, open.view.n), this.total);
      }
    } catch (err) {}
    this.#layout();
    this.#showChrome();
    updateBook(book.id, { lastOpenedAt: Date.now() });
    // Closed the book while looking something up: offer the way back.
    if (this.readingPos !== this.#currentPage()) {
      this.returnTo = { page: this.readingPos, view: null, moves: 0 };
      this.#syncReturn();
    }
  }

  // ------------------------------------------------------------------ DOM

  #build() {
    const el = (this.el = document.createElement('div'));
    el.className = `reader${this.kind === 'comic' ? ' comic' : ''}${this.rtl ? ' rtl' : ''}${this.webtoon ? ' webtoon' : ''}`;
    el.innerHTML = `
      <div class="stage">
        <div class="camera">
          <div class="book"></div>
          <div class="strip"></div>
          <div class="hl-layer"></div>
        </div>
      </div>
      <button class="edge-arrow prev" aria-label="Previous page">${icons.chevronLeft}</button>
      <button class="edge-arrow next" aria-label="Next page">${icons.chevronRight}</button>
      <div class="chrome">
        <div class="thumbstrip" hidden></div>
        <nav class="toolbar" aria-label="Reading tools">
          <button data-act="close" class="tb ghost" aria-label="Back to library">${icons.back}</button>
          <span class="tb-sep"></span>
          <button data-act="thumbs" class="tb" aria-label="Page thumbnails">${icons.thumbs}</button>
          <span class="tb-sep"></span>
          <button data-act="first" class="tb" aria-label="First page">${icons.first}</button>
          <button data-act="jumpBack" class="tb" aria-label="Back several pages">${icons.jumpBack}</button>
          <button data-act="prev" class="tb" aria-label="Previous page">${icons.prev}</button>
          <button data-act="goto" class="tb-page" aria-label="Go to page"><span class="cur"></span><span class="of"></span></button>
          <button data-act="next" class="tb" aria-label="Next page">${icons.next}</button>
          <button data-act="jumpFwd" class="tb" aria-label="Forward several pages">${icons.jumpFwd}</button>
          <button data-act="last" class="tb" aria-label="Last page">${icons.last}</button>
          <span class="tb-sep"></span>
          <button data-act="speak" class="tb" aria-label="Read selection aloud">${icons.speaker}</button>
          <button data-act="lock" class="tb" aria-label="Lock orientation" aria-pressed="false">${icons.lock}</button>
          <button data-act="fullscreen" class="tb" aria-label="Full screen">${icons.expand}</button>
          <span class="tb-sep"></span>
          <button data-act="settings" class="tb ghost" aria-label="Settings">${icons.settings}</button>
        </nav>
      </div>
      <button class="zoom-chip" data-act="resetZoom" hidden aria-label="Reset zoom"></button>
      <div class="tts-bar" hidden role="group" aria-label="Read aloud" data-state="ready">
        <span class="tts-wave"><i></i><i></i><i></i><i></i></span>
        <span class="tts-label" aria-live="polite"></span>
        <button data-act="ttsMode" class="tts-mode" role="switch" aria-checked="false">Continuous</button>
        <button data-act="ttsBack" class="tts-btn" aria-label="Back a sentence">${icons.rewind}</button>
        <button data-act="ttsToggle" class="tts-btn" aria-label="Pause">${icons.pause}</button>
        <button data-act="ttsStop" class="tts-btn" aria-label="Stop">${icons.stop}</button>
        <button data-act="ttsMore" class="tts-more" aria-expanded="false" aria-label="More">${icons.chevronRight}</button>
        <span class="tts-sep"></span>
        <button data-act="ttsClose" class="tts-close" aria-label="Close read aloud">${icons.close}</button>
        <div class="tts-panel" hidden>
          <button data-act="ttsFollow" class="tts-mode" role="switch" aria-checked="true">Follow the voice</button>
          <button data-act="ttsPick" class="tts-pick" aria-pressed="false">Read from another place</button>
        </div>
      </div>
      <div class="word-pop" hidden role="dialog" aria-label="Translation"></div>
      <div class="toast" hidden></div>
      <button class="pos-ribbon" hidden aria-label="Reading position"><svg viewBox="0 0 18 38" aria-hidden="true"><defs><linearGradient id="ribGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8c089"/><stop offset="1" stop-color="#c0904f"/></linearGradient></defs><path d="M1.5 0.8h15v35.5l-7.5-7-7.5 7z"/></svg><span class="rib-p"></span></button>
      <div class="rib-menu" hidden role="menu"><button data-act="ribHere" role="menuitem">Read from here</button><button data-act="ribStop" role="menuitem">Mark where I stopped</button></div>
      <div class="return-pill" hidden><button data-act="returnBack" class="rp-go">${icons.back}<span></span></button><button data-act="returnDismiss" class="rp-x" aria-label="Stay here">${icons.close}</button></div>
      <div class="place-hint" hidden><span>Tap the line where you stopped</span><button data-act="placeCancel">Cancel</button></div>
    `;
    this.root.append(el);
    this.stage = el.querySelector('.stage');
    this.cameraEl = el.querySelector('.camera');
    this.bookEl = el.querySelector('.book');
    this.stripEl = el.querySelector('.strip');
    this.hlLayer = el.querySelector('.hl-layer');
    this.chrome = el.querySelector('.chrome');
    this.pop = el.querySelector('.word-pop');
    el.querySelector('.tb-page .of').textContent = `/${this.total}`;
    this.#syncFullscreenButton();
  }

  #applySettings(s) {
    const toneChanged = this.settings.pageTone !== s.pageTone;
    this.settings = s;
    this.el.dataset.backdrop = s.backdrop;
    this.el.dataset.tone = s.pageTone;
    if (toneChanged) this.#retone();
    this.el.classList.toggle('toolbar-top', s.toolbarPosition === 'top');
    if (this.focus && s.focusZoom === false) this.#layout();
    if (this.tools) this.tools.sync();
  }

  // ---- reading position, the way back, and where you stopped

  #setReadingPos(n) {
    if (n === this.readingPos) return;
    this.readingPos = n;
    this.#syncRibbon();
    this.book.readingPos = n;
    clearTimeout(this.posTimer);
    this.posTimer = setTimeout(() => updateBook(this.book.id, { readingPos: n }), 600);
    if (this.tools) this.tools.decorateAll();
  }

  /** A jump elsewhere in the book (search, contents, bookmarks…): remember the way back. */
  async #jumpTo(n, opts) {
    this.returnShowUntil = Date.now() + this.#returnMs();
    // The zoom itself (not the on-screen page size): the way back is usually taken
    // after the Search panel has closed and the book has its full width again.
    if (!this.returnTo) this.returnTo = { page: this.readingPos, view: { ...this.#viewAnchor(), w: 0 }, moves: 0 };
    this.jumpPending = true;
    try {
      await this.#goToPage(n, opts);
    } finally {
      this.jumpPending = false;
    }
    // Landed back where you were reading: nothing to return to.
    if (this.returnTo && visiblePages(spreadPages(this.mode, this.spread, this.total)).includes(this.returnTo.page)) this.returnTo = null;
    // Counting page turns from here on (a new jump starts the count again).
    if (this.returnTo) {
      this.returnTo.last = this.#currentPage();
      this.returnTo.forward = 0;
    }
    this.#syncReturn();
    this.#syncRibbon();
  }

  async #goBack() {
    const r = this.returnTo;
    if (!r) return;
    this.returnTo = null;
    this.#syncReturn();
    this.jumpPending = true;
    try {
      await this.go(spreadOf(this.mode, r.page));
      // The same spot and zoom as before, when the layout is still the same.
      if (r.view && r.view.mode === this.mode) this.#restoreView(r.view);
    } finally {
      this.jumpPending = false;
    }
    this.#setReadingPos(r.page);
  }

  /**
   * "Back to page N": shown while Search is open, and for a few seconds after
   * a jump or after Search closes. (The way back itself stays until you read
   * on: the gold ribbon in Bookmarks still leads there.)
   */
  #syncReturn() {
    const pill = this.el.querySelector('.return-pill');
    const r = this.returnTo;
    const away = r && !visiblePages(spreadPages(this.mode, this.spread, this.total)).includes(r.page);
    const searching = this.tools && this.tools.searchActive;
    const left = (this.returnShowUntil || 0) - Date.now();
    const show = away && (searching || left > 0);
    pill.hidden = !show;
    if (show) pill.querySelector('.rp-go span').textContent = `Back to page ${r.page}`;
    clearTimeout(this.returnTimer);
    if (show && !searching) this.returnTimer = setTimeout(() => this.#syncReturn(), left + 30);
  }

  /** How long "Back to page N" stays (Settings). */
  #returnMs() {
    return (this.settings.returnSeconds || 7) * 1000;
  }

  // ---- the gold ribbon (reading position), over the page you're reading

  /** The page being read: in a zoomed spread, the one filling most of the screen. */
  #primaryPage() {
    if (this.mode === 'single') return this.#stripCurrent();
    const shown = visiblePages(spreadPages('double', this.spread, this.total));
    if (!this.camera.zoomed) return shown.includes(this.readingPos) ? this.readingPos : shown[0];
    const box = this.el.getBoundingClientRect();
    let best = shown[0];
    let most = -1;
    for (const n of shown) {
      const p = this.bookEl.querySelector(`.slot .page[data-page="${n}"]`);
      if (!p) continue;
      const r = p.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left)) * Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top));
      if (area > most) (most = area), (best = n);
    }
    return best;
  }

  /** Put the ribbon at the top of its page, or at the top of the screen when zoomed past it. */
  /** Away from the reading position after a jump (until you go back or read on). */
  #away() {
    const r = this.returnTo;
    return !!r && !visiblePages(spreadPages(this.mode, this.spread, this.total)).includes(r.page);
  }

  /**
   * The ribbon: solid gold on the page you're reading. Away after a jump, a
   * hollow one on the page you're looking at says where your reading
   * position is ("p. 74"): tap it to go back, hold it to read from here.
   */
  #syncRibbon() {
    const rib = this.ribbon || (this.ribbon = this.el.querySelector('.pos-ribbon'));
    const root = this.mode === 'single' ? this.stripEl : this.bookEl;
    const away = this.#away();
    const on = away ? this.#primaryPage() : this.readingPos;
    const p = !this.busy && root && root.querySelector(`.slot .page[data-page="${on}"]`);
    const box = this.el.getBoundingClientRect();
    const r = p && p.getBoundingClientRect();
    // Near the page's top right corner; zoomed past that corner, kept just inside the screen.
    let x = r && Math.max(8, Math.min(box.width - 48, r.right - r.width * 0.08 - 34 - box.left));
    const visible = r && r.bottom > box.top + 60 && r.top < box.bottom - 60 && r.right > box.left + 60 && r.left < box.right - 60;
    if (!visible) {
      rib.hidden = true;
      this.ribbonPage = null;
      this.#closeRibMenu();
      return;
    }
    rib.classList.toggle('ghost', away);
    rib.querySelector('.rib-p').textContent = away ? `p. ${this.readingPos}` : '';
    rib.setAttribute('aria-label', away ? `Your reading position is page ${this.readingPos}. Tap to go back; hold to read from here.` : 'Reading position. Hold to mark where you stopped.');
    const y = Math.max(0, r.top - box.top);
    // At the top of the screen, stay clear of the zoom chip there.
    const chip = this.el.querySelector('.zoom-chip');
    const cr = chip && !chip.hidden && chip.getBoundingClientRect();
    if (cr && cr.width && y < cr.bottom - box.top && x + 34 > cr.left - box.left) x = cr.left - box.left - 44;
    rib.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    rib.classList.toggle('stuck', y === 0 && r.top < box.top);
    rib.classList.toggle('zoomed', this.camera.zoomed); // see-through over a zoomed page
    const key = `${on}${away ? 'g' : ''}`;
    if (rib.hidden || this.ribbonPage !== key) {
      // Arriving on a new page: slide in.
      rib.classList.remove('arrive');
      void rib.offsetWidth;
      rib.classList.add('arrive');
    }
    rib.hidden = false;
    this.ribbonPage = key;
    if (this.ribMenu && !this.ribMenu.hidden) this.#placeRibMenu();
  }

  #remoteChange(patch, info) {
    for (const k of ['bookmarks', 'stopMark', 'seriesName', 'seriesIndex', 'finished']) if (k in patch) this.book[k] = patch[k];
    if (this.tools) this.tools.decorateAll();
    const n = patch.lastPage;
    if (!n || visiblePages(spreadPages(this.mode, this.spread, this.total)).includes(n)) return;
    let pill = this.el.querySelector('.sync-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'return-pill sync-pill';
      pill.innerHTML = `<button class="rp-go">${icons.bookmark}<span></span></button><button class="rp-x" aria-label="Stay here">${icons.close}</button>`;
      pill.querySelector('.rp-go').addEventListener('click', async () => {
        pill.hidden = true;
        await this.#jumpTo(pill.page);
        this.#readFromHere();
      });
      pill.querySelector('.rp-x').addEventListener('click', () => (pill.hidden = true));
      this.el.append(pill);
    }
    pill.page = n;
    pill.querySelector('.rp-go span').textContent = `Continue at p. ${n}${info && info.from ? ` · ${info.from}` : ''}`;
    pill.hidden = false;
    clearTimeout(this.syncPillTimer);
    this.syncPillTimer = setTimeout(() => (pill.hidden = true), 15000);
  }

  /** Make the page being read now the reading position (the hollow ribbon fills in). */
  #readFromHere(auto = false) {
    const n = this.#primaryPage();
    this.returnTo = null;
    this.#closeRibMenu();
    this.#setReadingPos(n);
    this.#syncReturn();
    this.#syncRibbon();
    const rib = this.ribbon;
    rib.classList.remove('filling');
    void rib.offsetWidth;
    rib.classList.add('filling');
    clearTimeout(this.fillTimer);
    this.fillTimer = setTimeout(() => rib.classList.remove('filling'), 900);
    this.#toast(`Reading position moved to page ${n}`);
  }

  #openRibMenu() {
    this.ribMenu.hidden = false;
    this.#placeRibMenu();
  }

  #closeRibMenu() {
    if (this.ribMenu) this.ribMenu.hidden = true;
  }

  #placeRibMenu() {
    const m = this.ribMenu;
    const box = this.el.getBoundingClientRect();
    const r = this.ribbon.getBoundingClientRect();
    const w = m.offsetWidth;
    const x = Math.max(8, Math.min(box.width - w - 8, r.left + r.width / 2 - box.left - w + 24));
    m.style.transform = `translate(${Math.round(x)}px, ${Math.round(r.bottom - box.top + 8)}px)`;
  }

  #bindRibbon() {
    const rib = this.el.querySelector('.pos-ribbon');
    let timer = null;
    rib.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      rib.classList.add('pressed');
      timer = setTimeout(() => {
        timer = null;
        rib.classList.remove('pressed');
        if (navigator.vibrate) navigator.vibrate(12);
        if (rib.classList.contains('ghost')) this.#openRibMenu();
        else this.#startPlacing();
      }, LONG_PRESS_MS);
    });
    const end = (e) => {
      rib.classList.remove('pressed');
      if (timer) {
        clearTimeout(timer);
        timer = null;
        if (e.type !== 'pointerup') return;
        if (rib.classList.contains('ghost')) this.#goBack();
        else this.#toast(`Reading position · page ${this.readingPos} — hold to mark the line where you stopped`);
      }
    };
    rib.addEventListener('pointerup', end);
    rib.addEventListener('pointercancel', end);
    rib.addEventListener('pointerleave', end);
    rib.addEventListener('click', (e) => e.stopPropagation());
    this.ribMenu = this.el.querySelector('.rib-menu');
    this.ribMenu.addEventListener('pointerdown', (e) => e.stopPropagation());
    // Anywhere else closes the little menu.
    const outside = (e) => {
      if (!this.ribMenu.hidden && !this.ribMenu.contains(e.target) && !rib.contains(e.target)) this.#closeRibMenu();
    };
    document.addEventListener('pointerdown', outside, true);
    this.cleanups.push(() => document.removeEventListener('pointerdown', outside, true));
  }

  #startPlacing() {
    this.placing = true;
    this.el.classList.add('placing');
    this.el.querySelector('.place-hint').hidden = false;
    this.#hideChrome();
  }

  #stopPlacing() {
    this.placing = false;
    this.el.classList.remove('placing');
    this.el.querySelector('.place-hint').hidden = true;
  }

  /** The page element under a screen point, with its rectangle. */
  #pageAt(x, y) {
    const root = this.mode === 'single' ? this.stripEl : this.bookEl;
    for (const p of root.querySelectorAll('.slot .page[data-page]')) {
      const r = p.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { el: p, n: +p.dataset.page, rect: r };
    }
    return null;
  }

  /** The line of text at height y on a page (its spans, left to right), or null. */
  #lineAt(pageEl, x, y) {
    const layer = pageEl.querySelector('.textLayer');
    const spans = layer ? collectSpans([layer]) : [];
    if (!spans.length) return null;
    const rects = spans.map((s) => s.getBoundingClientRect());
    let best = -1;
    let bestD = Infinity;
    rects.forEach((r, i) => {
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const score = d * 3 + dx * 0.05;
      if (score < bestD) (bestD = score), (best = i);
    });
    if (best < 0 || bestD > 90) return null;
    const mid = (rects[best].top + rects[best].bottom) / 2;
    const h = rects[best].height;
    const line = spans.map((s, i) => ({ s, r: rects[i] })).filter((o) => Math.abs((o.r.top + o.r.bottom) / 2 - mid) < h * 0.5).sort((a, b) => a.r.left - b.r.left);
    return { text: line.map((o) => o.s.textContent).join(' ').replace(/\s+/g, ' ').trim(), rects: line.map((o) => o.r), mid };
  }

  async #placeAt(ptr) {
    this.#stopPlacing();
    const hit = this.#pageAt(ptr.cx0, ptr.cy0);
    if (!hit) return this.#toast('Tap on a page to mark where you stopped');
    const line = this.#lineAt(hit.el, ptr.cx0, ptr.cy0);
    const fy = ((line ? line.mid : ptr.cy0) - hit.rect.top) / hit.rect.height;
    const mark = { page: hit.n, fy: Math.max(0, Math.min(1, fy)), line: line ? line.text.slice(0, 160) : '', at: Date.now() };
    this.book.stopMark = mark;
    await updateBook(this.book.id, { stopMark: mark });
    this.tools.decorateAll();
    if (line) this.#flash(line.rects, 'stopline');
    if (navigator.vibrate) navigator.vibrate(10);
    this.#toast(line ? `Marked where you stopped · page ${hit.n}` : `Marked the spot on page ${hit.n} (no text there to mark a line)`);
  }

  /** Back to where you stopped: that page, the line marked (or the spot, if no line was recorded). */
  async #goToStop() {
    const m = this.book.stopMark;
    if (!m) return this.#toast('Nothing marked yet — use “Mark where I stopped”');
    await this.#jumpTo(m.page);
    let shown = null;
    for (let t = 0; t < 30 && !(shown = this.#shownPageText(m.page)); t++) await new Promise((r) => setTimeout(r, 100));
    const pageEl = (this.mode === 'single' ? this.stripEl : this.bookEl).querySelector(`.slot .page[data-page="${m.page}"]`);
    if (!pageEl) return;
    const pr = pageEl.getBoundingClientRect();
    let rects = null;
    if (m.line && shown) {
      // Find the marked line again: the occurrence of its text nearest the marked height.
      const key = m.line.slice(0, 40).toLowerCase();
      const hay = shown.text.toLowerCase();
      let best = null;
      for (let at = hay.indexOf(key); at >= 0; at = hay.indexOf(key, at + 1)) {
        let a = at;
        let b = Math.min(shown.text.length, at + m.line.length) - 1;
        while (a < b && !shown.map[a]) a++;
        while (b > a && !shown.map[b]) b--;
        if (!shown.map[a] || !shown.map[b]) continue;
        const rs = rangeRects(shown.spans, shown.map[a], { index: shown.map[b].index, offset: shown.map[b].offset + 1 });
        if (!rs.length) continue;
        const d = Math.abs((rs[0].top + rs[0].bottom) / 2 - (pr.top + m.fy * pr.height));
        if (!best || d < best.d) best = { d, rs };
      }
      if (best) rects = best.rs;
    }
    if (!rects) {
      // No line to show: mark the height that was recorded, and say so.
      const y = pr.top + m.fy * pr.height;
      rects = [{ left: pr.left + pr.width * 0.04, right: pr.right - pr.width * 0.04, top: y - 14, bottom: y + 14, width: pr.width * 0.92, height: 28 }];
      this.#flash(rects, 'stopband');
      this.#toast(m.line ? 'The marked line moved — showing the marked spot' : 'No exact line was recorded here — this is the marked spot');
    } else this.#flash(rects, 'stopline');
    await this.#reveal(rects);
  }

  /** Mark rectangles briefly (they fade away). */
  #flash(rects, cls, ms = 3200) {
    this.#drawHighlights(rects, cls);
    const marks = [...this.hlLayer.querySelectorAll(`.hl.${cls}`)];
    this.findFade = setTimeout(() => {
      for (const m of marks) m.classList.add('fading');
      setTimeout(() => marks.forEach((m) => m.remove()), 700);
    }, ms);
  }

  /** Bring rectangles into view, keeping the zoom. */
  async #reveal(rects) {
    const box = this.el.getBoundingClientRect();
    const l = Math.min(...rects.map((x) => x.left)) - box.left;
    const r = Math.max(...rects.map((x) => x.right)) - box.left;
    const t = Math.min(...rects.map((x) => x.top)) - box.top;
    const b = Math.max(...rects.map((x) => x.bottom)) - box.top;
    const cam = this.camera;
    if (l > this.W * 0.06 && r < this.W * 0.94 && t > this.H * 0.12 && b < this.H * 0.8) return;
    if (!cam.zoomed && this.mode !== 'single') return; // the whole spread is on screen
    const dx = r - l > this.W * 0.9 ? 0 : this.W / 2 - (l + r) / 2;
    await cam.animateTo(cam.s, cam.tx + dx, cam.ty + (this.H * 0.42 - (t + b) / 2), 420);
    if (this.mode === 'single') this.#syncStrip();
  }

  /** Go to page n (from search, bookmarks, contents); with `find`, mark that match on it. */
  async #goToPage(n, { find, nth = 0 } = {}) {
    await this.go(spreadOf(this.mode, n));
    if (!find) return;
    const token = (this.findToken = (this.findToken || 0) + 1);
    let shown = null;
    for (let t = 0; t < 30 && token === this.findToken && !(shown = this.#shownPageText(n)); t++) await new Promise((r) => setTimeout(r, 100));
    if (!shown || token !== this.findToken) return;
    const hay = shown.text.toLowerCase();
    const needle = find.toLowerCase();
    const hits = [];
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) hits.push(at);
    if (!hits.length) return;
    const at = hits[Math.min(nth, hits.length - 1)];
    let a = at;
    let b = at + needle.length - 1;
    while (a < b && !shown.map[a]) a++;
    while (b > a && !shown.map[b]) b--;
    if (!shown.map[a] || !shown.map[b]) return;
    const rects = rangeRects(shown.spans, shown.map[a], { index: shown.map[b].index, offset: shown.map[b].offset + 1 });
    if (!rects.length) return;
    // Keep the zoom: bring the match into view, then let the mark fade.
    this.#flash(rects, 'find', 2600);
    await this.#reveal(rects);
  }

  // ------------------------------------------------------------------ layout

  /**
   * Chapter start pages from the book's table of contents (PDF bookmarks),
   * so the double arrows can jump chapter to chapter. Stays null for books
   * without one.
   */
  async #loadChapters() {
    try {
      const outline = await this.doc.getOutline();
      const starts = new Set();
      const titled = [];
      const walk = async (items, depth) => {
        for (const it of items || []) {
          let page = null;
          try {
            let dest = it.dest;
            if (typeof dest === 'string') dest = await this.doc.getDestination(dest);
            const ref = dest && dest[0];
            const index = typeof ref === 'number' ? ref : ref ? await this.doc.getPageIndex(ref) : -1;
            if (index >= 0) {
              page = index + 1;
              starts.add(page);
            }
          } catch (e) {}
          if (it.title) titled.push({ title: it.title.trim(), page, depth });
          await walk(it.items, depth + 1);
        }
      };
      await walk(outline, 0);
      this.outlineItems = titled;
      const list = [...starts].filter((p) => p >= 1 && p <= this.total).sort((a, b) => a - b);
      this.chapters = list.length >= 2 ? list : null;
    } catch (e) {
      this.chapters = null;
    }
    this.#updateJumpLabels();
  }

  #useChapters() {
    return !!this.chapters && this.settings.jumpMode !== 'pages';
  }

  #updateJumpLabels() {
    const ch = this.#useChapters();
    this.el.querySelector('[data-act="jumpBack"]').setAttribute('aria-label', ch ? 'Previous chapter' : 'Back several pages');
    this.el.querySelector('[data-act="jumpFwd"]').setAttribute('aria-label', ch ? 'Next chapter' : 'Forward several pages');
  }

  /** Double arrows: to the next / previous chapter if the book has a table of contents, else a fixed number of pages. */
  #jump(dir) {
    if (this.#useChapters()) {
      const shown = visiblePages(spreadPages(this.mode, this.spread, this.total));
      const lo = Math.min(...shown);
      const hi = Math.max(...shown);
      // Back: the start of this chapter, or of the previous one if its start is already on screen.
      const target = dir > 0 ? this.chapters.find((p) => p > hi) : [...this.chapters].reverse().find((p) => p < lo);
      if (target) return this.go(spreadOf(this.mode, target));
      if (dir < 0) return this.go(0); // before the first chapter: the very beginning
    }
    return this.step(dir * this.settings.jumpPages);
  }

  #currentPage() {
    return this.mode ? visiblePages(spreadPages(this.mode, this.spread, this.total))[0] : this.startPage;
  }

  #layout() {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (!W || !H) return;
    // The exact view to keep: the same screen with a new size (e.g. full
    // screen ended while away in Google Translate), or reopening the app.
    const keep = this.mode ? this.#viewAnchor() : this.pendingView || null;
    // Search docking beside the book: keep the zoom itself, not the page's size on screen.
    if (keep && this.keepZoom) keep.w = 0;
    this.keepZoom = false;
    if (!this.mode && this.pendingView) this.focus = !!this.pendingView.focus;
    // The layout the screen calls for; zoomed into one page in landscape
    // ("focus"), the one-page scroll is used instead of the spread.
    // (Search docked beside the book narrows it: the layout still follows the whole screen.)
    const natural = this.webtoon ? 'single' : this.lock.locked ? this.lock.lockedMode : W + (this.dockPx || 0) > H ? 'double' : 'single';
    if (natural !== 'double' || this.settings.focusZoom === false) this.focus = false;
    this.natural = natural;
    const mode = natural === 'double' && this.focus ? 'single' : natural;
    const aspect = this.#aspect();
    const pw = this.#pageWidth(mode, W, H);
    const ph = Math.floor(pw / aspect);
    const changed = mode !== this.mode || pw !== this.pw || ph !== this.ph || W !== this.W || H !== this.H;
    if (!changed) return;
    const page = this.forcePage || this.#currentPage();
    this.forcePage = null;
    if (W !== this.W || H !== this.H) this.#resetPointers(); // rotated or resized: fingers start afresh
    const modeChanged = mode !== this.mode;
    Object.assign(this, { W, H, pw, ph, mode });
    this.el.style.setProperty('--pw', `${pw}px`);
    this.el.style.setProperty('--ph', `${ph}px`);
    this.el.dataset.mode = mode;
    this.cameraEl.style.width = `${W}px`;
    this.cameraEl.style.height = `${H}px`;
    this.camera.stop();
    this.camera.setView(W, H);
    this.#cancelTurn();
    this.#clearHighlights();
    this.#closePopup();
    this.renderZoom = 1;
    this.cache.setWidth(pw);
    this.spread = spreadOf(mode, page);

    if (mode === 'double') {
      this.#drop([...this.stripEl.children]);
      this.stripPages.clear();
      const w = pw * 2;
      this.bookEl.style.width = `${w}px`;
      this.bookEl.style.height = `${ph}px`;
      this.bookEl.style.perspective = `${Math.round(w * 2.2)}px`;
      this.camera.setBox({ x: (W - w) / 2, y: (H - ph) / 2, w, h: ph });
      this.camera.set(1, 0, 0);
      this.#renderSpread();
    } else {
      this.#drop([...this.bookEl.children, ...this.stripEl.children]);
      this.stripPages.clear();
      this.#measureStrip();
      const stripH = this.tops[this.total] + this.stripPad;
      Object.assign(this.stripEl.style, { width: `${pw}px`, height: `${stripH}px`, left: `${(W - pw) / 2}px` });
      const m = Math.max(0, Math.min(16, (W - pw) / 2));
      this.camera.setBox({ x: (W - pw) / 2 - m, y: 0, w: pw + 2 * m, h: stripH });
      this.#scrollToPage(page, false);
      this.#syncStrip();
    }
    this.#updateZoomChip();
    this.#updateIndicator();
    if (modeChanged) this.thumbs.rebuild();
    // Same layout as before (only the size changed): same zoom, same spot.
    if (keep && keep.mode === mode) this.#restoreView(keep);
    this.pendingView = null;
    if (this.tools) this.tools.layout();
    requestAnimationFrame(() => this.#syncRibbon());
  }

  /**
   * Where the reader is looking: the page at the middle of the screen, the
   * spot of that page there (as fractions of its size), and the zoom.
   */
  #viewAnchor() {
    const cam = this.camera;
    const cx = (this.W / 2 - cam.tx) / cam.s;
    const cy = (this.H / 2 - cam.ty) / cam.s;
    let n;
    let left;
    let top;
    if (this.mode === 'single') {
      n = this.#pageAtY(cy);
      left = (this.W - this.pw) / 2;
      top = this.#pageTop(n);
    } else {
      const r = this.#bookRect();
      const sp = spreadPages('double', this.spread, this.total);
      const right = sp.right && (cx >= r.left + this.pw || !sp.left);
      n = right ? sp.right : sp.left;
      left = r.left + (right ? this.pw : 0);
      top = r.top;
    }
    // w: the page's width on screen, so it keeps its size even if the layout's page size changes.
    return { mode: this.mode, focus: this.focus, n, fx: (cx - left) / this.pw, fy: (cy - top) / (this.mode === 'single' ? this.#pageH(n) : this.ph), s: cam.s, w: cam.s * this.pw };
  }

  /** Put the view back on a spot saved by #viewAnchor (in the current layout). */
  #restoreView(v) {
    let left;
    let top;
    if (this.mode === 'single') {
      left = (this.W - this.pw) / 2;
      top = this.#pageTop(v.n);
    } else {
      if (Math.abs(v.s - 1) < 0.02) return; // the whole spread: already showing
      const r = this.#bookRect();
      const sp = spreadPages('double', this.spread, this.total);
      if (v.n !== sp.left && v.n !== sp.right) return;
      left = r.left + (v.n === sp.right ? this.pw : 0);
      top = r.top;
    }
    const cam = this.camera;
    const x = left + v.fx * this.pw;
    const y = top + v.fy * (this.mode === 'single' ? this.#pageH(v.n) : this.ph);
    const s = Math.max(1, Math.min(MAX_ZOOM, v.w ? v.w / this.pw : v.s));
    cam.stop();
    cam.set(s, this.W / 2 - x * s, this.H / 2 - y * s);
    cam.flush();
    if (this.mode === 'single') this.#syncStrip();
  }

  #aspect() {
    return this.book.pageAspect || this.book.aspect || 0.7;
  }

  /** Page width (CSS px) for a layout on a W×H screen. */
  #pageWidth(mode, W, H) {
    if (mode === 'double') {
      const vpad = Math.max(18, H * 0.035);
      const hpad = Math.max(56, W * 0.05);
      return Math.floor(Math.min((W - 2 * hpad) / 2, (H - 2 * vpad) * this.#aspect()));
    }
    // Webtoons: a column about as wide as a tall screen's width; on phones, the whole width.
    if (this.webtoon) return Math.floor(Math.min(W, Math.max(Math.min(W, 720), H * 0.75)));
    // Portrait (and focus) reads as a scroll of full-width pages.
    return Math.floor(Math.min(W - 2 * Math.max(10, W * 0.025), 1200));
  }

  #offsetFor(index) {
    if (this.mode !== 'double') return 0;
    const s = spreadPages('double', index, this.total);
    if (!s.left && s.right) return -this.pw / 2; // cover alone, centred
    if (s.left && !s.right) return this.pw / 2; // back cover alone, centred
    return 0;
  }

  #setOffset(x) {
    this.offset = x;
    this.bookEl.style.transform = `translateX(${x}px)`;
  }

  /** Book rectangle in content coordinates (landscape). */
  #bookRect() {
    const w = this.pw * 2;
    const left = (this.W - w) / 2 + (this.offset || 0);
    const top = (this.H - this.ph) / 2;
    return { left, top, right: left + w, bottom: top + this.ph, width: w };
  }

  // ------------------------------------------------------------------ pages

  #pageEl(n, { text = true, prio = 0 } = {}) {
    const p = document.createElement('div');
    p.className = 'page';
    p.dataset.page = n;
    const canvas = document.createElement('canvas');
    p.append(canvas);
    p.painted = this.cache.paint(n, canvas, prio).catch(() => {});
    if (this.tools) this.tools.decoratePage(p, n);
    if (text) {
      const tl = document.createElement('div');
      tl.className = 'textLayer';
      p.append(tl);
      const pw = this.pw;
      this.cache
        .page(n)
        .then((page) => (p.isConnected ? buildTextLayer(page, tl, pw) : null))
        .catch(() => {});
      this.#addLinks(n, p);
    }
    return p;
  }

  /** Links on page n (table of contents and other links within the book), positions in % of the page. */
  #pageLinks(n) {
    this.linkCache = this.linkCache || new Map();
    if (!this.linkCache.has(n)) {
      this.linkCache.set(
        n,
        this.cache
          .page(n)
          .then(async (page) => {
            const vp = page.getViewport({ scale: 1 });
            const out = [];
            for (const a of await page.getAnnotations()) {
              if (a.subtype !== 'Link' || !a.rect) continue;
              const link = {};
              if (a.dest) {
                try {
                  let dest = a.dest;
                  if (typeof dest === 'string') dest = await this.doc.getDestination(dest);
                  const ref = dest && dest[0];
                  const index = typeof ref === 'number' ? ref : ref ? await this.doc.getPageIndex(ref) : -1;
                  if (index >= 0) link.page = index + 1;
                } catch (e) {}
              }
              // Only links within the book: web links never take you out of the app.
              if (!link.page) continue;
              // (PDF.js 6 dropped convertToViewportRectangle; points work in both.)
              const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
              const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
              link.left = (Math.min(x1, x2) / vp.width) * 100;
              link.top = (Math.min(y1, y2) / vp.height) * 100;
              link.width = (Math.abs(x2 - x1) / vp.width) * 100;
              link.height = (Math.abs(y2 - y1) / vp.height) * 100;
              out.push(link);
            }
            return out;
          })
          .catch(() => []),
      );
    }
    return this.linkCache.get(n);
  }

  /** Invisible link areas over the page; taps on them are handled in #tap. */
  #addLinks(n, pageEl) {
    this.#pageLinks(n).then((links) => {
      if (!links.length || !pageEl.isConnected) return;
      const layer = document.createElement('div');
      layer.className = 'linkLayer';
      for (const l of links) {
        const d = document.createElement('div');
        d.className = 'pdf-link';
        d.dataset.page = l.page;
        Object.assign(d.style, { left: `${l.left}%`, top: `${l.top}%`, width: `${l.width}%`, height: `${l.height}%` });
        layer.append(d);
      }
      pageEl.append(layer);
    });
  }

  /** The link under a screen point, if any (with a little slack for fingers). */
  #linkAt(x, y) {
    const root = this.mode === 'single' ? this.stripEl : this.bookEl;
    let best = null;
    let bestD = 10;
    for (const el of root.querySelectorAll('.slot .pdf-link')) {
      const r = el.getBoundingClientRect();
      const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      if (d < bestD) {
        bestD = d;
        best = el;
      }
    }
    return best;
  }

  #followLink(el) {
    el.classList.add('hit');
    setTimeout(() => el.classList.remove('hit'), 450);
    this.#jumpTo(+el.dataset.page); // a jump: "Back to page" takes you back (e.g. from a note)
  }

  #slot(cls, n, opts) {
    const s = document.createElement('div');
    s.className = `slot ${cls}`;
    if (n) s.append(this.#pageEl(n, opts));
    else s.classList.add('empty');
    return s;
  }

  /**
   * Draw spread `index` (landscape) as the resting state. With `replace`,
   * the new pages are laid over the given old elements and those are only
   * removed once the new pages are painted — so nothing flashes in between.
   */
  #renderSpread(index = this.spread, { replace = null } = {}) {
    const s = spreadPages(this.mode, index, this.total);
    const els = [this.#slot('left', s.left), this.#slot('right', s.right)];
    if (s.left && s.right) {
      const spine = document.createElement('div');
      spine.className = 'spine';
      els.push(spine);
    }
    this.#setOffset(this.#offsetFor(index));
    this.#prefetch(index);
    if (!replace) {
      this.#drop([...this.bookEl.children]);
      this.bookEl.append(...els);
      return Promise.resolve();
    }
    this.bookEl.append(...els);
    const paints = els.flatMap((e) => [...e.querySelectorAll('.page')].map((p) => p.painted));
    const timeout = new Promise((r) => setTimeout(r, 450));
    return Promise.race([Promise.all(paints), timeout])
      .then(() => new Promise(requestAnimationFrame))
      .then(() => {
        this.#drop(replace);
      });
  }

  #prefetch(index) {
    const n = spreadCount(this.mode, this.total);
    for (const d of [1, -1, 2]) {
      const i = index + d;
      if (i < 0 || i >= n) continue;
      for (const p of visiblePages(spreadPages(this.mode, i, this.total))) this.cache.get(p, 1).catch(() => {});
    }
  }

  // ---- portrait strip

  /** Where each page starts in the strip (webtoon pictures each have their own height). */
  #measureStrip() {
    const gap = this.webtoon ? 0 : STRIP_GAP;
    this.stripPad = this.webtoon ? 0 : STRIP_PAD;
    const tops = (this.tops = new Array(this.total + 1));
    let y = this.stripPad;
    for (let n = 1; n <= this.total; n++) {
      tops[n - 1] = y;
      y += this.#pageH(n) + (n < this.total ? gap : 0);
    }
    tops[this.total] = y;
  }

  /** Height of page n in the current layout. */
  #pageH(n) {
    return this.webtoon ? Math.round(this.doc.heightOf(n, this.pw)) : this.ph;
  }

  #pageTop(n) {
    return this.tops ? this.tops[Math.max(1, Math.min(this.total, n)) - 1] : STRIP_PAD;
  }

  #pageAtY(y) {
    const t = this.tops;
    if (!t) return 1;
    // The last page starting above y (halfway into a gap counts as the next page).
    const half = this.webtoon ? 0 : STRIP_GAP / 2;
    let lo = 1;
    let hi = this.total;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid - 1] - half <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Page considered "current" in the strip: the one under the upper third of the screen. */
  #stripCurrent() {
    const cam = this.camera;
    const y = (this.H * 0.33 - cam.ty) / cam.s;
    // At the very end, the last page counts even if it can't reach the reading line.
    if (-cam.ty + this.H >= this.stripEl.offsetHeight * cam.s - 2) return this.total;
    return this.#pageAtY(y);
  }

  #scrollToPage(n, animate = true) {
    const cam = this.camera;
    const ty = -(this.#pageTop(n) - 8) * cam.s;
    if (animate) return cam.animateTo(cam.s, cam.tx, ty, 420);
    cam.set(cam.s, cam.tx, ty);
  }

  /** Mount pages near the viewport, drop far-away ones. */
  #syncStrip() {
    if (this.mode !== 'single') return;
    const cam = this.camera;
    const top = -cam.ty / cam.s;
    const bottom = top + this.H / cam.s;
    const margin = this.H / cam.s;
    const first = this.#pageAtY(top - margin);
    const last = this.#pageAtY(bottom + margin);
    for (const [n, el] of this.stripPages) {
      if (n < first - 1 || n > last + 1) {
        this.#drop([el]);
        this.stripPages.delete(n);
      }
    }
    const visFirst = this.#pageAtY(top);
    const visLast = this.#pageAtY(bottom);
    for (let n = first; n <= last; n++) {
      if (this.stripPages.has(n)) continue;
      const slot = this.#slot('strip-page', n, { prio: n >= visFirst && n <= visLast ? 0 : 1 });
      slot.style.top = `${this.#pageTop(n)}px`;
      if (this.webtoon) slot.style.height = `${this.#pageH(n)}px`;
      this.stripEl.append(slot);
      this.stripPages.set(n, slot);
    }
  }

  // ---- zoom quality

  #onCamera() {
    // Zoomed into a spread: the page filling the screen is the one being read.
    // (The one-page view: the page at the reading line.)
    if ((this.mode === 'single' || this.camera.zoomed) && !this.returnTo && !this.jumpPending && !this.busy) this.#setReadingPos(this.#primaryPage());
    this.#syncRibbon();
    if (this.mode === 'single') {
      this.#syncStrip();
      const p = this.#stripCurrent();
      if (p - 1 !== this.spread) {
        this.spread = p - 1;
        this.#afterMove();
      }
    }
    this.#updateZoomChip();
    clearTimeout(this.hiResTimer);
    this.hiResTimer = setTimeout(() => this.#hiRes(), 260);
  }

  /** Page tone changed: re-render every mounted page (and the thumbnails) in the new tone. */
  #retone() {
    const tone = this.settings.pageTone;
    this.cache.setTone(tone);
    this.thumbs.cache.setTone(tone);
    this.thumbs.rebuild();
    const visible = new Set(this.#visibleCanvases());
    for (const c of this.cameraEl.querySelectorAll('.page canvas')) {
      delete c.dataset.zoom;
      this.cache.paint(+c.parentElement.dataset.page, c, visible.has(c) ? 0 : 1).catch(() => {});
    }
    if (this.camera.zoomed) {
      clearTimeout(this.hiResTimer);
      this.hiResTimer = setTimeout(() => this.#hiRes(), 300);
    }
  }

  /** Canvases of the pages currently on screen. */
  #visibleCanvases() {
    if (this.mode === 'double') return [...this.bookEl.querySelectorAll(':scope > .slot .page canvas')];
    const cam = this.camera;
    const first = this.#pageAtY(-cam.ty / cam.s);
    const last = this.#pageAtY((-cam.ty + this.H) / cam.s);
    const out = [];
    for (let n = first; n <= last; n++) {
      const c = this.stripPages.get(n)?.querySelector('.page canvas');
      if (c) out.push(c);
    }
    return out;
  }

  /**
   * After zooming settles, re-draw the on-screen pages sharp at the new size.
   * Only visible pages get the big version (memory is tight, especially on
   * iOS); everything else keeps the normal-size render from the cache.
   */
  async #hiRes() {
    if (this.pinch || this.busy) return (this.hiResTimer = setTimeout(() => this.#hiRes(), 260));
    const want = Math.min(MAX_ZOOM, Math.max(1, Math.round(this.camera.s * 2) / 2));
    this.renderZoom = want;
    const token = ++this.hiResToken;
    for (const c of this.#visibleCanvases()) {
      if (token !== this.hiResToken) return;
      const n = +c.parentElement.dataset.page;
      if ((+c.dataset.zoom || 1) === want) continue;
      if (want === 1) {
        await this.cache.paint(n, c, 0).catch(() => {});
        delete c.dataset.zoom;
        continue;
      }
      try {
        const tmp = await renderPageCanvas(await this.cache.page(n), this.pw * want, { maxPixels: ZOOM_PIXELS, maxDpr: 3, tone: this.settings.pageTone });
        if (token === this.hiResToken && c.isConnected && tmp.width) {
          c.width = tmp.width;
          c.height = tmp.height;
          c.getContext('2d').drawImage(tmp, 0, 0);
          c.dataset.zoom = want;
          if (!canvasOk(c)) {
            // Not enough memory for the sharp version: keep the normal one.
            delete c.dataset.zoom;
            releaseCanvas(tmp);
            this.cache.relieve();
            await this.cache.paint(n, c, 0).catch(() => {});
            continue;
          }
        }
        releaseCanvas(tmp);
      } catch {}
    }
  }

  /** Remove elements and free their page images immediately. */
  #drop(els) {
    for (const el of els) {
      for (const c of el.querySelectorAll?.('canvas') || []) releaseCanvas(c);
      el.remove();
    }
  }

  #updateZoomChip() {
    const chip = this.el.querySelector('.zoom-chip');
    const z = this.camera.s;
    chip.hidden = !this.camera.zoomed;
    chip.textContent = `${Math.round(z * 100)}%  ✕`;
  }

  // ------------------------------------------------------------------ navigation

  get spreadTotal() {
    return spreadCount(this.mode, this.total);
  }

  #label() {
    return spreadLabel(this.mode, this.spread, this.total);
  }

  #updateIndicator() {
    if (!this.gotoOpen) this.el.querySelector('.tb-page .cur').textContent = this.#label();
    const last = this.spread >= this.spreadTotal - 1;
    const first = this.spread <= 0;
    for (const a of ['prev', 'first', 'jumpBack']) this.el.querySelector(`[data-act="${a}"]`).disabled = first;
    for (const a of ['next', 'last', 'jumpFwd']) this.el.querySelector(`[data-act="${a}"]`).disabled = last;
    this.el.querySelector('.edge-arrow.prev').classList.toggle('disabled', first);
    this.el.querySelector('.edge-arrow.next').classList.toggle('disabled', last);
    this.thumbs.sync();
  }

  #saveProgress() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const finished = this.spread >= this.spreadTotal - 1 || this.book.finished;
      updateBook(this.book.id, { lastPage: this.#currentPage(), lastOpenedAt: Date.now(), finished });
    }, 500);
  }

  #afterMove() {
    if (this.readMode && this.kind === 'comic') setTimeout(() => this.#ocrOnScreen(), 300);
    this.#updateIndicator();
    this.#saveProgress();
    if (!this.jumpPending) {
      const r = this.returnTo;
      if (r) {
        const shown = visiblePages(spreadPages(this.mode, this.spread, this.total));
        const p = this.#currentPage();
        if (shown.includes(r.page)) this.returnTo = null; // back where you were, by hand
        else {
          // Reading on from where you landed: two page turns forward move the reading position here.
          if (r.last != null && p > r.last) r.forward = (r.forward || 0) + 1;
          else if (r.last != null && p < r.last) r.forward = 0;
          r.last = p;
          if (r.forward >= READ_ON_TURNS) this.#readFromHere(true);
        }
      }
      if (!this.returnTo) this.#setReadingPos(this.#primaryPage());
      this.#syncReturn();
    }
    this.#syncRibbon();
    if (this.camera.zoomed) {
      clearTimeout(this.hiResTimer);
      this.hiResTimer = setTimeout(() => this.#hiRes(), 120);
    }
  }

  /** Move by a number of pages. */
  step(pages) {
    if (Math.abs(pages) === 1) return this.go(this.spread + pages);
    // Land on the spread that contains the page exactly `pages` away.
    const page = Math.max(1, Math.min(this.total, this.#currentPage() + pages));
    let target = spreadOf(this.mode, page);
    if (target === this.spread) target += Math.sign(pages);
    this.go(target);
  }

  async go(target, { animate = true } = {}) {
    target = Math.max(0, Math.min(this.spreadTotal - 1, target));
    this.#clearHighlights(true);
    this.#closePopup();

    if (this.mode === 'single') {
      const near = Math.abs(target - this.spread) <= 2;
      this.spread = target;
      await this.#scrollToPage(target + 1, animate && near);
      this.spread = this.#stripCurrent() - 1;
      return this.#afterMove();
    }

    if (this.busy || target === this.spread) return;
    const from = this.spread;
    let style = animate ? this.settings.pageTurn : 'none';
    // Zoomed in (landscape): by default switch instantly and stay zoomed;
    // optionally zoom out first and then turn; or turn while zoomed.
    const zoomed = this.camera.zoomed;
    if (zoomed && this.settings.zoomTurn === 'stay') style = 'none';
    if (zoomed && this.settings.zoomTurn === 'zoomOut') {
      this.busy = true;
      await this.camera.animateTo(1, 0, 0, 300);
      this.busy = false;
    }
    this.cache.demoteAll();
    if (TURNERS[style] && Math.abs(target - from) > 1) {
      await this.#riffle(target > from ? 1 : -1, target);
    } else if (TURNERS[style]) {
      const turn = this.#beginTurn(target > from ? 1 : -1, target);
      await turn.flip.animateTo(1, 680);
      await this.#endTurn(turn, true);
    } else if (style === 'slide') {
      await this.#slide(target > from ? 1 : -1, target);
    } else {
      this.spread = target;
      await this.#renderSpread(target, { replace: [...this.bookEl.children] });
    }
    // Still zoomed in? Start the new spread from its top-left corner (going back: top-right).
    if (this.camera.zoomed) {
      const box = this.camera.box;
      const s = this.camera.s;
      this.camera.set(s, target < from ? this.W - (box.x + box.w) * s : -box.x * s, -box.y * s);
    }
    this.#afterMove();
  }

  async #slide(dir, target) {
    this.busy = true;
    const old = [...this.bookEl.children];
    for (const o of old) {
      o.style.transition = 'transform 340ms cubic-bezier(.3,.7,.2,1), opacity 300ms';
    }
    // The book offset (cover centring) is shared; let it glide too.
    this.bookEl.style.transition = 'transform 360ms cubic-bezier(.3,.7,.2,1)';
    this.spread = target;
    const paint = this.#renderSpread(target, { replace: [] });
    const fresh = [...this.bookEl.children].filter((c) => !old.includes(c));
    for (const f of fresh) {
      f.style.opacity = '0';
      f.style.transform = `translateX(${dir * 60}px)`;
    }
    await paint;
    await new Promise(requestAnimationFrame);
    for (const f of fresh) {
      f.style.transition = 'transform 360ms cubic-bezier(.3,.7,.2,1), opacity 300ms';
      f.style.opacity = '1';
      f.style.transform = '';
    }
    for (const o of old) {
      o.style.opacity = '0';
      o.style.transform = `translateX(${-dir * 60}px)`;
    }
    await new Promise((r) => setTimeout(r, 380));
    this.bookEl.style.transition = '';
    this.#drop(old);
    for (const f of fresh) f.style.transition = '';
    this.busy = false;
  }

  /**
   * A jump of several spreads: a thick bundle of pages turns over together,
   * fanning slightly so its edges show. Always the same bundle, however far
   * the jump. Only the outer sheets carry real pages (what was showing, and
   * where we land); the ones inside are paper with the impression of print.
   */
  async #riffle(dir, target) {
    this.busy = true;
    const SHEETS = LOW_MEMORY ? 5 : 7; // the whole bundle, outer sheets included
    const DUR = 760; // each sheet's turn: about as slow as one heavy page
    const FAN = 0.15; // how far the bundle fans open mid-turn (share of a full turn)
    const book = this.bookEl;
    const from = this.spread;
    const cur = spreadPages(this.mode, from, this.total);
    const next = spreadPages(this.mode, target, this.total);
    const fwd = dir > 0;
    // Underneath: the page that stays (the bundle lands on it) and the target
    // page on the other side, uncovered as the bundle lifts.
    const stay = fwd ? cur.left : cur.right;
    const reveal = fwd ? next.right : next.left;
    const under = [this.#slot('left', fwd ? stay : reveal, { text: false }), this.#slot('right', fwd ? reveal : stay, { text: false })];
    const old = [...book.children];
    book.append(...under);
    // Sheets that have landed go below this marker, sheets in the air above it.
    const marker = document.createComment('riffle');
    book.append(marker);
    const offFrom = this.#offsetFor(from);
    const offTo = this.#offsetFor(target);
    const Turner = TURNERS[this.settings.pageTurn] || FoldFlipper;
    const partsOf = (f) => [f.cast, f.leaf, f.root].filter(Boolean);
    // Pages inside the bundle: paper with the impression of printed lines
    // (Soft page slices real page images, so it gets plain paper).
    const filler = () => {
      if (Turner === BendFlipper) return null;
      const d = document.createElement('div');
      d.className = 'page paper-blank filler';
      return d;
    };
    const realPages = [];
    const sheets = [];
    for (let i = 0; i < SHEETS; i++) {
      const first = i === 0;
      const last = i === SHEETS - 1;
      const fp = first ? (fwd ? cur.right : cur.left) : null;
      const bp = last ? (fwd ? next.left : next.right) : null;
      const front = fp ? this.#pageEl(fp, { text: false }) : first ? null : filler();
      const back = bp ? this.#pageEl(bp, { text: false }) : last ? null : filler();
      realPages.push(...[front, back].filter(Boolean));
      const sheet = { crossed: false, landed: false };
      sheet.flip = new Turner({
        book,
        mode: this.mode,
        dir,
        pw: this.pw,
        ph: this.ph,
        front,
        back,
        spineFrom: false,
        spineTo: false,
        onProgress: (t) => {
          if (first) this.#setOffset(offFrom + (offTo - offFrom) * t);
          // Past the spine the bundle is upside down: the sheets that were
          // underneath are now on top, so each one moves up as it passes the middle.
          if (!sheet.crossed && t >= 0.5 && sheet.flip) {
            sheet.crossed = true;
            book.append(...partsOf(sheet.flip));
          }
        },
      });
      // One shadow for the whole bundle, cast by the sheet nearest the page it uncovers.
      if (!last) for (const sh of [sheet.flip.cast, sheet.flip.root && sheet.flip.root.querySelector('.under')]) if (sh) sh.style.visibility = 'hidden';
      // Each later sheet lies under the earlier ones.
      marker.after(...partsOf(sheet.flip));
      sheets.push(sheet);
    }
    // One clock for the whole bundle, so the sheets stay together even when
    // frames are slow.
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    await new Promise((resolve) => {
      const start = performance.now();
      let dropped = false;
      const frame = (now) => {
        const el = now - start;
        const k = Math.min(1, el / DUR);
        const e = ease(k);
        // The sheets lift and land together and fan open in between, each a
        // little behind the one above it.
        const fan = FAN * Math.sin(Math.PI * k);
        let done = true;
        sheets.forEach((sh, i) => {
          if (sh.landed) return;
          sh.flip.set(Math.max(0, e - (fan * i) / (SHEETS - 1)));
          if (k >= 1) {
            sh.landed = true;
            marker.before(...partsOf(sh.flip)); // lies on top of the sheets landed before it
          } else done = false;
        });
        // The old resting spread is covered once the bundle is moving.
        if (!dropped && el > 120) {
          dropped = true;
          this.#drop(old);
        }
        if (done) {
          if (!dropped) this.#drop(old);
          resolve();
        } else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    this.spread = target;
    await this.#renderSpread(target, { replace: [...book.children].filter((c) => c !== marker) });
    for (const sh of sheets) sh.flip.destroy();
    this.#drop([...realPages, ...sheets.flatMap((sh) => partsOf(sh.flip))]);
    marker.remove();
    this.busy = false;
  }

  /** Set up a page turn: the pages uncovered underneath and the turning leaf. */
  #beginTurn(dir, target) {
    this.busy = true;
    const from = this.spread;
    const cur = spreadPages(this.mode, from, this.total);
    const next = spreadPages(this.mode, target, this.total);
    const book = this.bookEl;
    const left = dir > 0 ? cur.left : next.left;
    const right = dir > 0 ? next.right : cur.right;
    const under = [this.#slot('left', left, { text: false }), this.#slot('right', right, { text: false })];
    if (left && right) {
      const spine = document.createElement('div');
      spine.className = 'spine';
      under.push(spine);
    }
    const fp = dir > 0 ? cur.right : cur.left;
    const bp = dir > 0 ? next.left : next.right;
    const front = fp ? this.#pageEl(fp, { text: false }) : null;
    const back = bp ? this.#pageEl(bp, { text: false }) : null;
    // The turning sheet carries its half of the fold shading: it fades as the
    // page lifts off and returns as the other side lands, matching the
    // resting spreads before and after the turn.
    const spineFrom = !!(cur.left && cur.right);
    const spineTo = !!(next.left && next.right);
    if (front) front.dataset.spine = dir > 0 ? 'left' : 'right';
    if (back) back.dataset.spine = dir > 0 ? 'right' : 'left';
    const style = this.settings.pageTurn;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const shadeSpine = (t) => {
      const f = style === 'fold' ? 1 : clamp01(1 - 2 * t);
      const b = style === 'fold' ? t * t : clamp01(2 * t - 1);
      front?.style.setProperty('--spine-o', (spineFrom ? f : 0).toFixed(3));
      back?.style.setProperty('--spine-o', (spineTo ? b : 0).toFixed(3));
    };
    // Lay the turning set over the resting spread; drop the old one once painted.
    const old = [...book.children];
    book.append(...under);
    const offFrom = this.#offsetFor(from);
    const offTo = this.#offsetFor(target);
    const Turner = TURNERS[this.settings.pageTurn] || FoldFlipper;
    const flip = new Turner({
      book,
      mode: this.mode,
      dir,
      pw: this.pw,
      ph: this.ph,
      front,
      back,
      spineFrom,
      spineTo,
      onProgress: (t) => {
        this.#setOffset(offFrom + (offTo - offFrom) * t);
        shadeSpine(t);
      },
    });
    const pages = [...under.flatMap((u) => [...u.querySelectorAll('.page')]), front, back].filter(Boolean);
    Promise.race([Promise.all(pages.map((p) => p.painted)), new Promise((r) => setTimeout(r, 300))]).then(() => this.#drop(old));
    this.turn = { flip, dir, from, target, pages: [front, back].filter(Boolean) };
    return this.turn;
  }

  async #endTurn(turn, commit) {
    if (commit) this.spread = turn.target;
    await this.#renderSpread(this.spread, { replace: [...this.bookEl.children] });
    this.#disposeTurn(turn);
    if (this.turn === turn) this.turn = null;
    this.busy = false;
  }

  /** Remove a turn's leaf and free its page images (iOS keeps them otherwise). */
  #disposeTurn(turn) {
    turn.flip.destroy();
    this.#drop([...turn.pages, turn.flip.leaf, turn.flip.cast, turn.flip.root].filter(Boolean));
  }

  #cancelTurn() {
    if (this.turn) {
      this.#disposeTurn(this.turn);
      this.turn = null;
    }
    this.busy = false;
  }

  // ------------------------------------------------------------------ chrome

  #showChrome() {
    this.el.classList.add('chrome-on', 'arrows-on');
    this.#armHide();
  }

  #armHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.thumbs.open || this.gotoOpen) return this.#armHide();
      this.el.classList.remove('chrome-on', 'arrows-on');
    }, this.settings.autoHideSeconds * 1000);
  }

  #hideChrome() {
    clearTimeout(this.hideTimer);
    this.el.classList.remove('chrome-on', 'arrows-on');
    this.thumbs.close();
  }

  #showArrows() {
    this.el.classList.add('arrows-on');
    clearTimeout(this.arrowTimer);
    this.arrowTimer = setTimeout(() => this.el.classList.remove('arrows-on'), this.settings.autoHideSeconds * 1000);
  }

  #toast(msg) {
    const t = this.el.querySelector('.toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (t.hidden = true), 2400);
  }

  #syncFullscreenButton() {
    const btn = this.el.querySelector('[data-act="fullscreen"]');
    const on = !!fsElement();
    const supported = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
    btn.hidden = !supported || appIsFullscreen();
    btn.innerHTML = on ? icons.shrink : icons.expand;
    btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    btn.classList.toggle('on', on);
  }

  // ------------------------------------------------------------------ input

  #bindInput() {
    const el = this.el;
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this.cleanups.push(() => target.removeEventListener(type, fn, opts));
    };

    on(el, 'click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      this.#action(btn.dataset.act, btn);
    });

    on(this.stage, 'pointerdown', (e) => this.#down(e));
    on(this.stage, 'contextmenu', (e) => e.preventDefault()); // press and hold is ours (translation)
    // Every touch on the page is handled here. Saying so stops the browser
    // treating a tap as unanswered and stepping in itself (Chrome on Android
    // offers "Touch to Search" for a word tapped on an idle page).
    on(this.stage, 'touchend', (e) => e.cancelable && e.preventDefault(), { passive: false });
    on(window, 'pointermove', (e) => this.#move(e));
    on(window, 'pointerup', (e) => this.#up(e));
    on(window, 'pointercancel', (e) => this.#up(e, true));
    for (const a of el.querySelectorAll('.edge-arrow')) {
      on(a, 'pointerdown', (e) => this.#down(e, a.classList.contains('next') ? 'arrow-next' : 'arrow-prev'));
    }
    on(this.chrome, 'pointerdown', () => this.#armHide());
    on(window, 'pointermove', (e) => this.#handleMove(e));
    on(window, 'pointerup', (e) => this.#handleUp(e));
    on(window, 'pointercancel', (e) => this.#handleUp(e));
    on(this.pop, 'pointerdown', (e) => {
      e.stopPropagation();
      if (this.popCloseTimer) this.#armPopupClose(); // using the bubble restarts its countdown
    });
    on(this.stage, 'wheel', (e) => this.#wheel(e), { passive: false });
    on(document, 'fullscreenchange', () => this.#syncFullscreenButton());
    on(document, 'webkitfullscreenchange', () => this.#syncFullscreenButton());

    on(window, 'keydown', (e) => {
      if (e.target.closest?.('input, textarea, [contenteditable]')) return; // typing, not turning pages
      const k = e.key;
      const portrait = this.mode === 'single';
      if (portrait && (k === 'ArrowDown' || k === ' ')) this.camera.animateTo(this.camera.s, this.camera.tx, this.camera.ty - this.H * 0.85, 300), e.preventDefault();
      else if (portrait && k === 'ArrowUp') this.camera.animateTo(this.camera.s, this.camera.tx, this.camera.ty + this.H * 0.85, 300), e.preventDefault();
      else if (k === 'PageDown' || k === ' ') this.step(1), e.preventDefault();
      else if (k === 'PageUp') this.step(-1), e.preventDefault();
      else if (k === 'ArrowRight' || k === 'ArrowLeft') this.step((k === 'ArrowRight') !== this.rtl ? 1 : -1), e.preventDefault(); // manga: the next page is to the left
      else if (k === 'Home') this.go(0);
      else if (k === 'End') this.go(this.spreadTotal - 1);
      else if (k === 'Escape') this.#closePopup();
    });

    const lostFingers = () => this.#resetPointers();
    on(window, 'blur', lostFingers);
    on(window, 'orientationchange', lostFingers);
    on(document, 'visibilitychange', () => document.hidden && lostFingers());
    on(document, 'visibilitychange', () => this.#onVisibility());

    const ro = new ResizeObserver(() => this.#layout());
    ro.observe(el);
    this.cleanups.push(() => ro.disconnect());
  }

  #action(act, btn) {
    this.#armHide();
    const s = this.settings;
    switch (act) {
      case 'close':
        return this.nav.back(); // to wherever the book was opened from
      case 'settings':
        return this.nav(`#/settings?from=${encodeURIComponent(location.hash)}`);
      case 'thumbs':
        this.thumbs.toggle();
        return btn.classList.toggle('on', this.thumbs.open);
      case 'first':
        return this.#jumpTo(1);
      case 'last':
        return this.#jumpTo(this.total);
      case 'prev':
        return this.step(-1);
      case 'next':
        return this.step(1);
      case 'jumpBack':
        return this.#jump(-1);
      case 'jumpFwd':
        return this.#jump(1);
      case 'goto':
        return this.#openGoto(btn);
      case 'speak':
        return this.readMode ? this.#exitReadMode() : this.#enterReadMode();
      case 'ttsClose':
        return this.#exitReadMode();
      case 'lock':
        return this.#toggleLock(btn);
      case 'fullscreen':
        return fsElement() ? exitFullscreen() : enterFullscreen();
      case 'resetZoom':
        return this.#resetZoom();
      case 'ttsToggle':
        return this.speech.toggle();
      case 'ttsStop':
        return this.speech.stop();
      case 'ttsBack':
        return this.speech.back();
      case 'returnBack':
        return this.#goBack();
      case 'returnDismiss':
        return this.#readFromHere();
      case 'ribHere':
        return this.#readFromHere();
      case 'ribStop':
        this.#closeRibMenu();
        return this.#startPlacing();
      case 'placeCancel':
        return this.#stopPlacing();
      case 'ttsMode':
        setSetting('readContinuous', !this.settings.readContinuous);
        return this.#onSpeechState(this.speech.state);
      case 'ttsMore':
        this.ttsMore = !this.ttsMore;
        return this.#paintTtsPanel();
      case 'ttsFollow':
        setSetting('readFollow', !this.settings.readFollow);
        this.#paintTtsPanel();
        // Following again: show where the voice is now.
        if (this.settings.readFollow && this.aloud && this.lastPiece != null) this.#onPiece(this.lastPiece);
        return;
      case 'ttsPick':
        return this.#setPicking(!this.picking);
      case 'popSpeak': {
        const cur = this.popSound && this.popSound.state;
        if (cur === 'loading') return; // already on its way: extra taps don't queue more
        if (cur === 'playing') return stopPronounce(); // the button is a stop button now
        const snd = (this.popSound = { word: this.popWord.text, state: 'loading', was: 'idle' });
        pronounce(this.popWord.text, this.popWord.lang, (state) => {
          if (this.popSound !== snd) return;
          snd.was = snd.state;
          snd.state = state;
          this.#paintSound();
          // The bubble stays open while the word is loading or playing.
          if (state === 'idle') this.#armPopupClose();
          else clearTimeout(this.popCloseTimer);
        });
        return this.#paintSound();
      }
      case 'popOcrLang': {
        // The bubbles of this book are in another language: remember it, and read this one again.
        const lang = btn.dataset.lang;
        this.book.comic = Object.assign({}, this.book.comic, { ocr: lang });
        updateBook(this.book.id, { comic: this.book.comic });
        // What was read in the other language goes; it is read again as needed.
        const pages = [...this.doc.ocr.keys()];
        this.doc.ocr.clear();
        for (const n of pages) this.#refreshOcrLayers(n);
        this.#clearHighlights();
        if (this.ocrAt) this.#readBubble(this.ocrAt.cx, this.ocrAt.cy);
        this.#ocrOnScreen();
        return;
      }
      case 'popCopy':
        navigator.clipboard?.writeText(this.popWord.text).then(() => this.#toast('Copied'));
        return;
    }
  }

  #resetZoom() {
    const cam = this.camera;
    if (this.mode === 'single') {
      // Keep the same part of the page at the top of the screen.
      const c = cam.toContent(this.W / 2, 0);
      return cam.animateTo(1, 0, -c.y, 280);
    }
    return cam.animateTo(1, 0, 0, 280);
  }

  #openGoto(btn) {
    if (this.gotoOpen) return;
    this.gotoOpen = true;
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = 1;
    input.max = this.total;
    input.className = 'goto-input';
    input.placeholder = this.#currentPage();
    input.setAttribute('aria-label', `Page number, 1 to ${this.total}`);
    btn.replaceChildren(input, Object.assign(document.createElement('span'), { className: 'of', textContent: `/${this.total}` }));
    input.focus();
    const done = (go) => {
      if (!this.gotoOpen) return;
      this.gotoOpen = false;
      const n = parseInt(input.value, 10);
      btn.innerHTML = `<span class="cur"></span><span class="of">/${this.total}</span>`;
      this.#updateIndicator();
      if (go && n >= 1 && n <= this.total) this.#jumpTo(n);
      this.#armHide();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
  }

  async #toggleLock(btn) {
    const mode = this.natural || this.mode; // landscape stays landscape while zoomed into one page
    const locked = await this.lock.toggle(mode);
    btn.innerHTML = locked ? icons.locked : icons.lock;
    btn.classList.toggle('on', locked);
    btn.setAttribute('aria-pressed', String(locked));
    this.#toast(locked ? `Locked to ${mode === 'double' ? 'landscape' : 'portrait'}` : 'Orientation unlocked');
  }

  // Pointer state machine ----------------------------------------------------
  //
  // One finger: tap / double-tap (zoom in and back), press and hold (translate
  // the word), page-turn drag (landscape, not zoomed), pan (portrait, or
  // zoomed), or text selection (read-aloud mode).
  // Two fingers: pinch-zoom.

  #local(e) {
    const p = this.lock.toLocal(e.clientX, e.clientY);
    if (this.rtl) p.x = this.el.offsetWidth - p.x; // the page area is mirrored
    return p;
  }

  /** A screen rectangle in the page area's own coordinates. */
  #rectLocal(r) {
    const l = this.lock.rectToLocal(r);
    if (this.rtl) l.left = this.el.offsetWidth - l.left - l.width;
    return l;
  }

  #zone(p) {
    if (this.mode !== 'double') return 'center';
    const r = this.#bookRect();
    const edge = Math.max(70, this.pw * 0.26);
    if (p.x > r.right - edge) return 'edge-next';
    if (p.x < r.left + edge) return 'edge-prev';
    return 'center';
  }

  #down(e, forced) {
    if (e.button > 0) return;
    e.stopPropagation();
    // A first finger means no other finger is on the screen. If we still
    // think one is, its lift was never reported (iOS can drop it during a
    // rotation or when the page under it is swapped): forget it, or every
    // one-finger move would be taken for a pinch with that "ghost" finger.
    if (e.isPrimary && this.pointers.size) this.#resetPointers();
    // Keep receiving this finger's moves and lift even if the element it
    // started on is removed meanwhile (page turns, layout changes).
    try {
      if (e.pointerType === 'touch' && this.stage.setPointerCapture) this.stage.setPointerCapture(e.pointerId);
    } catch (err) {}
    const p = this.#local(e);
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 2 && !this.busy) {
      // Second finger: abandon the one-finger gesture (page drag or a just-started
      // read-aloud selection) and pinch instead.
      const drag = this.ptr?.drag;
      if (drag?.turn) drag.turn.flip.animateTo(0).then(() => this.#endTurn(drag.turn, false));
      if (this.ptr?.selecting) {
        this.sel = null;
        // Only erase a half-drawn new selection, not the passage currently being read.
        if (this.ptr.moved) this.hlLayer.querySelectorAll('.hl.sel').forEach((h) => h.remove());
      }
      this.ptr = null;
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      this.#stopEdgeScroll();
      return this.#pinchStart();
    }
    if (this.pointers.size > 1) return;

    this.camera.stop();
    if (!this.pop.hidden) {
      // The translation bubble is open: a tap or a drag only closes it, but a
      // press and hold on another word translates that one straight away.
      const ptr = (this.ptr = { id: e.pointerId, x0: p.x, y0: p.y, lx: p.x, ly: p.y, cx0: e.clientX, cy0: e.clientY, t0: performance.now(), zone: 'center', dismiss: true });
      clearTimeout(this.pressTimer);
      this.pressTimer = setTimeout(() => this.#longPress(ptr), LONG_PRESS_MS);
      return;
    }
    this.ptr = { id: e.pointerId, x0: p.x, y0: p.y, lx: p.x, ly: p.y, cx0: e.clientX, cy0: e.clientY, t0: performance.now(), zone: forced || this.#zone(p) };
    // Read-aloud mode: a drag that starts on text selects it; anywhere else behaves as usual.
    if (this.readMode && this.#mayPick() && this.#selectStart(e)) {
      this.ptr.selecting = true;
      e.preventDefault();
    }
    const ptr = this.ptr;
    clearTimeout(this.pressTimer);
    this.pressTimer = setTimeout(() => this.#longPress(ptr), LONG_PRESS_MS);
  }

  /** A touch while the bubble was open turned out not to be a hold: close the bubble. */
  #dismissPopup(ptr) {
    if (this.ptr === ptr) this.ptr = null; // the rest of this touch does nothing
    clearTimeout(this.pressTimer);
    this.#closePopup();
    this.#clearHighlights();
  }

  /** Forget every finger on the screen (and any gesture in progress). */
  #resetPointers() {
    this.#stopEdgeScroll();
    this.pointers.clear();
    this.pinch = null;
    this.ptr = null;
    clearTimeout(this.pressTimer);
  }

  /** Press and hold (without moving): translate the word under the finger. */
  #longPress(ptr) {
    if (this.ptr !== ptr || ptr.moved || this.pinch || this.pointers.size !== 1 || ptr.zone.indexOf('arrow') === 0) return;
    if (ptr.selecting) {
      ptr.selecting = false; // a hold on text in read-aloud mode translates instead of selecting
      this.sel = null;
    }
    clearTimeout(this.tapTimer);
    this.lastTap = null;
    this.wordSel = null;
    if (this.kind === 'comic') {
      // Comics have no text to select: read the words from the picture.
      ptr.pressed = true;
      if (navigator.vibrate) navigator.vibrate(8);
      this.#readBubble(ptr.cx0, ptr.cy0);
      return;
    }
    this.#lookupWord(ptr.cx0, ptr.cy0);
    if (this.wordSel) {
      ptr.pressed = true; // lifting the finger then does nothing more…
      ptr.anchor = { a: this.wordSel.a, b: this.wordSel.b }; // …unless it drags on to select more
      if (navigator.vibrate) navigator.vibrate(8);
    }
  }

  /**
   * After a press and hold has picked a word, dragging on without lifting the
   * finger grows the selection, like dragging a handle: from the pressed word
   * to wherever the finger is, forwards or backwards, word by word (or a
   * single punctuation mark).
   */
  #extendFromPress(e, ptr, p) {
    const sel = this.wordSel;
    if (!sel || !ptr.anchor) return;
    if (!ptr.extended && Math.hypot(p.x - ptr.x0, p.y - ptr.y0) < MOVE_SLOP) return;
    const pos = hitTest(sel.spans, e.clientX, e.clientY, { mode: 'char', maxDist: 40 });
    const u = pos && selectableAt(sel.spans, pos);
    if (!u) return;
    const a = before(u.a, ptr.anchor.a) ? u.a : ptr.anchor.a;
    const b = before(ptr.anchor.b, u.b) ? u.b : ptr.anchor.b;
    if (!ptr.extended) {
      ptr.extended = true;
      clearTimeout(this.popCloseTimer); // no closing while the selection is being adjusted
      this.pop.classList.add('adjusting');
    }
    if (same(a, sel.a) && same(b, sel.b)) return;
    sel.a = a;
    sel.b = b;
    const rects = rangeRects(sel.spans, a, b);
    this.#drawHighlights(rects, 'word');
    this.#placeHandles(rects);
  }

  /**
   * Double tap: zoom in where tapped; double tap again: back to the normal
   * view. In landscape (with "One page when zoomed in") it zooms straight
   * into the tapped page as a single page, and back out to the spread.
   */
  async #doubleTapZoom(x, y) {
    if (this.busy) return;
    const cam = this.camera;
    cam.stop();
    this.#closePopup();
    if (this.focus) return this.#leaveFocus({ reset: true });
    if (cam.zoomed) {
      const c = cam.toContent(x, y);
      return cam.animateTo(1, x - c.x, y - c.y, 300);
    }
    if (this.mode === 'double' && this.settings.focusZoom !== false) {
      // Zoom until the tapped page is as wide as it is on its own, then hand over to the one-page view.
      const r = this.#bookRect();
      const sp = spreadPages('double', this.spread, this.total);
      let right = x >= r.left + this.pw;
      if (right && !sp.right) right = false;
      if (!right && !sp.left) right = true;
      const pageLeft = r.left + (right ? this.pw : 0);
      const S = this.#focusEnterScale();
      this.busy = true;
      await cam.animateTo(S, (this.W - this.pw * S) / 2 - pageLeft * S, y * (1 - S), 320);
      this.busy = false;
      return this.#enterFocus({ x: this.W / 2, y });
    }
    const S = Math.min(MAX_ZOOM, DOUBLE_TAP_ZOOM);
    const c = cam.toContent(x, y);
    return cam.animateTo(S, x - c.x * S, y - c.y * S, 300);
  }

  #move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.#local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pinch) return this.#pinchMove();
    const ptr = this.ptr;
    if (!ptr || e.pointerId !== ptr.id) return;
    if (ptr.pressed) {
      this.#extendFromPress(e, ptr, p);
      // Near the edge of the screen the view scrolls on, so the selection can grow past it.
      if (ptr.extended) this.#edgeScroll(e.clientX, e.clientY, (x, y) => this.ptr === ptr && this.#extendFromPress({ clientX: x, clientY: y }, ptr, p));
      return;
    }
    if (ptr.dismiss) {
      if (Math.hypot(p.x - ptr.x0, p.y - ptr.y0) > MOVE_SLOP) this.#dismissPopup(ptr);
      return;
    }
    if (ptr.selecting) {
      if (Math.hypot(p.x - ptr.x0, p.y - ptr.y0) > MOVE_SLOP) ptr.moved = true;
      return ptr.moved && this.#selectMove(e);
    }
    const dx = p.x - ptr.x0;
    const dy = p.y - ptr.y0;
    if (Math.hypot(dx, dy) > MOVE_SLOP) ptr.moved = true;
    if (ptr.moved) this.userMovedAt = performance.now(); // (read-aloud waits a moment before following again)

    // A finger starting at the very top or bottom edge is the system's (its menus, going Home):
    // the page doesn't move for it.
    if (ptr.moved && !ptr.drag && !ptr.pan && e.pointerType === 'touch' && (ptr.cy0 < SYSTEM_EDGE || ptr.cy0 > window.innerHeight - SYSTEM_EDGE)) ptr.system = true;
    if (!ptr.drag && !ptr.pan && !ptr.chromeShown && !ptr.system && ptr.moved) {
      const swipe = this.#zoomedSwipe(dx, dy);
      if (swipe) {
        ptr.drag = { dir: swipe, swipeOnly: true, zoomed: true };
        this.#closePopup();
      } else if (this.mode === 'single' || this.camera.zoomed) {
        const cam = this.camera;
        ptr.pan = { samples: [], from: { s: cam.s, tx: cam.tx, ty: cam.ty }, at: performance.now() };
        this.lastPan = ptr.pan;
        this.#closePopup();
      } else if (Math.abs(dx) > MOVE_SLOP || Math.abs(dy) > 40) {
        // Landscape, not zoomed: swipes from the page edge turn the page.
        const horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
        const fromNext = ptr.zone === 'edge-next' || ptr.zone === 'arrow-next';
        const fromPrev = ptr.zone === 'edge-prev' || ptr.zone === 'arrow-prev';
        const dir = fromNext && dx < 0 ? 1 : fromPrev && dx > 0 ? -1 : 0;
        if (horizontal && dir && !this.busy) {
          const target = this.spread + dir;
          if (target >= 0 && target < this.spreadTotal) {
            this.#clearHighlights(true);
            ptr.drag = TURNERS[this.settings.pageTurn] ? { dir, turn: this.#beginTurn(dir, target), samples: [] } : { dir, swipeOnly: true };
          }
        } else if (!horizontal && this.#inChromeZone(ptr)) {
          ptr.chromeShown = true;
          this.#showChrome();
        }
      }
    }

    if (ptr.pan) {
      this.camera.panBy(p.x - ptr.lx, p.y - ptr.ly);
      ptr.pan.samples.push({ x: p.x, y: p.y, t: performance.now() });
      if (ptr.pan.samples.length > 5) ptr.pan.samples.shift();
    } else if (ptr.drag?.turn) {
      const r = this.#bookRect();
      const flip = ptr.drag.turn.flip;
      const tilt = ((p.y - (r.top + this.ph / 2)) / this.ph) * -9 * ptr.drag.dir;
      if (flip.follow) flip.follow(p.x - r.left, p.y - r.top, ptr.x0 - r.left, ptr.y0 - r.top);
      else flip.set(flip.progressFromX(p.x - r.left, ptr.x0 - r.left), tilt);
      ptr.drag.samples.push({ x: p.x, t: performance.now() });
      if (ptr.drag.samples.length > 6) ptr.drag.samples.shift();
    }
    ptr.lx = p.x;
    ptr.ly = p.y;
  }

  /**
   * Landscape, zoomed in: is this the start of a swipe that turns the page (1 next, -1 back)?
   * Slightly zoomed (up to SWIPE_TURN_ZOOM), a sideways swipe turns the page as when not zoomed;
   * further in, a sideways swipe turns it once the view is already at that edge of the spread
   * (the first swipe pans there).
   */
  #zoomedSwipe(dx, dy) {
    const cam = this.camera;
    if (this.mode !== 'double' || !cam.zoomed || this.busy) return 0;
    if (Math.abs(dx) < MOVE_SLOP || Math.abs(dx) < Math.abs(dy) * 1.4) return 0;
    const dir = dx < 0 ? 1 : -1;
    const target = this.spread + dir;
    if (target < 0 || target >= this.spreadTotal) return 0;
    if (cam.s <= SWIPE_TURN_ZOOM) return dir;
    // (Called as the finger starts moving, before anything has panned.)
    const edge = cam.clamp(cam.s, cam.tx - dir * 4, cam.ty, true).tx;
    return Math.abs(edge - cam.tx) < 0.5 ? dir : 0;
  }

  #inChromeZone(ptr) {
    const top = this.el.classList.contains('toolbar-top');
    return top ? ptr.y0 < 80 : ptr.y0 > this.H - 80;
  }

  async #up(e, cancelled = false) {
    if (this.refullscreen) {
      this.refullscreen = false;
      enterFullscreen();
    }
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.#pinchEnd();
      return;
    }
    const ptr = this.ptr;
    if (!ptr || e.pointerId !== ptr.id) return;
    this.ptr = null;
    clearTimeout(this.pressTimer);
    this.#stopEdgeScroll();
    if (ptr.pressed) {
      // The hold already translated; if the finger then dragged, translate the grown selection.
      if (ptr.extended && !cancelled) {
        this.pop.classList.remove('adjusting');
        this.#translateSelection();
      } else if (ptr.extended) this.pop.classList.remove('adjusting');
      return;
    }
    if (ptr.dismiss) return this.#dismissPopup(ptr);
    if (ptr.selecting) {
      // A plain tap on text is still a tap (toolbar / double-tap zoom).
      if (!ptr.moved) {
        this.sel = null;
        if (!cancelled && performance.now() - ptr.t0 < 600 && !this.#readFrom(ptr)) this.#tap(ptr);
        return;
      }
      return this.#selectEnd(e, cancelled);
    }

    if (ptr.pan) {
      // Taken over by the system (a gesture to go Home that began as a scroll): back to where it was.
      if (cancelled) {
        const f = ptr.pan.from;
        this.camera.stop();
        this.camera.set(f.s, f.tx, f.ty);
        this.camera.flush();
        return;
      }
      const s = ptr.pan.samples;
      if (s.length > 1 && !cancelled) {
        const a = s[0];
        const b = s[s.length - 1];
        const dt = Math.max(1, b.t - a.t);
        if (performance.now() - b.t < 80) this.camera.fling((b.x - a.x) / dt, (b.y - a.y) / dt);
      }
      return;
    }
    if (ptr.drag) {
      if (ptr.drag.zoomed) {
        // Zoomed in: a short or hesitant swipe is not a page turn.
        const far = Math.abs(ptr.lx - ptr.x0) > Math.min(90, this.W * 0.08);
        return far && !cancelled ? this.go(this.spread + ptr.drag.dir) : undefined;
      }
      if (ptr.drag.swipeOnly) return this.go(this.spread + ptr.drag.dir);
      const { turn, samples, dir } = ptr.drag;
      // Fling velocity (px/ms, positive = in the turning direction).
      let v = 0;
      if (samples.length > 1) {
        const a = samples[0];
        const b = samples[samples.length - 1];
        v = ((a.x - b.x) / Math.max(1, b.t - a.t)) * dir;
      }
      const t = turn.flip.t;
      const commit = !cancelled && (t > 0.5 ? v > -0.3 : v > 0.45 || (t > 0.35 && v > 0.15));
      await turn.flip.animateTo(commit ? 1 : 0);
      await this.#endTurn(turn, commit);
      if (commit) this.#afterMove();
      return;
    }
    if (cancelled || ptr.moved || performance.now() - ptr.t0 > 600) return;
    this.#tap(ptr);
  }

  #pinchStart() {
    this.userMovedAt = performance.now();
    const [a, b] = [...this.pointers.values()];
    this.camera.stop();
    this.#closePopup();
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), s0: this.camera.s, c: this.camera.toContent(mid.x, mid.y), mid };
  }

  #pinchMove() {
    const [a, b] = [...this.pointers.values()];
    const { d0, s0, c } = this.pinch;
    let s = Math.min(MAX_ZOOM * 1.15, (s0 * Math.hypot(a.x - b.x, a.y - b.y)) / d0);
    if (this.focus) {
      // Below "page as wide as the screen" the zoom resists.
      const floor = this.#focusFloor();
      if (s < floor) s = Math.max(floor * 0.7, floor - (floor - s) * FOCUS_GIVE);
    } else s = Math.max(0.8, s);
    const mid = (this.pinch.mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    this.camera.set(s, mid.x - c.x * s, mid.y - c.y * s);
  }

  #pinchEnd() {
    const { mid } = this.pinch;
    this.pinch = null;
    this.ptr = null; // the finger left on screen starts nothing new
    this.#zoomSettled(mid);
  }

  /**
   * A zoom gesture ended. In landscape, zooming in until one page is as wide
   * as the screen switches to the one-page view ("focus"); zooming out past
   * the whole page, with some margin to spare, goes back to the spread.
   * Otherwise the zoom springs back within its limits.
   */
  #zoomSettled(mid) {
    const cam = this.camera;
    if (!this.busy && this.focus && cam.s < this.#focusFloor() * FOCUS_EXIT) return this.#leaveFocus();
    if (!this.busy && !this.focus && this.mode === 'double' && this.settings.focusZoom !== false && cam.s >= this.#focusEnterScale()) {
      return this.#enterFocus(mid);
    }
    const s = Math.max(this.focus ? this.#focusFloor() : 1, Math.min(MAX_ZOOM, cam.s));
    if (s !== cam.s) {
      const c = cam.toContent(mid.x, mid.y);
      cam.animateTo(s, mid.x - c.x * s, mid.y - c.y * s, 220);
    }
  }

  // ------------------------------------------------------------------ one page when zoomed in (landscape)

  /** Zoom of the spread at which one page is exactly as wide as in the one-page view. */
  #focusEnterScale() {
    const single = this.#pageWidth('single', this.W, this.H);
    return Math.max(1.3, Math.min(MAX_ZOOM * 0.95, single / this.pw));
  }

  /** Zoom of the one-page view below which it resists, and then returns to the spread: the page exactly as wide as the screen. */
  #focusFloor() {
    return 1;
  }

  /** A page element lifted out of the layout, kept on screen at `r` while the layout changes beneath it. */
  #ghost(pageEl, r) {
    const g = document.createElement('div');
    g.className = 'focus-ghost';
    Object.assign(g.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    for (const x of pageEl.querySelectorAll('.textLayer, .linkLayer')) x.remove();
    g.append(pageEl);
    this.stage.append(g);
    return g;
  }

  /** Show `old`'s picture in the (not yet painted) canvas of page n, so it never appears blank. */
  #adopt(n, old) {
    if (!old || !old.width) return;
    const root = this.mode === 'single' ? this.stripEl : this.bookEl;
    const c = root.querySelector(`.slot .page[data-page="${n}"] canvas`);
    if (!c || c.classList.contains('ready')) return;
    c.width = old.width;
    c.height = old.height;
    const ctx = c.getContext('2d');
    if (ctx) ctx.drawImage(old, 0, 0);
  }

  /**
   * Spread → one page. The page under the fingers stays exactly where it is
   * on screen while the layout is swapped beneath it (same size, same place),
   * then glides to the middle as its partner page fades away.
   */
  async #enterFocus(mid) {
    const pages = [...this.bookEl.querySelectorAll(':scope > .slot > .page')];
    if (!pages.length) return;
    const rects = pages.map((p) => this.#rectLocal(p.getBoundingClientRect()));
    let k = rects.findIndex((r) => mid.x >= r.left && mid.x <= r.left + r.width);
    if (k < 0) {
      const shown = (r) => Math.max(0, Math.min(this.W, r.left + r.width) - Math.max(0, r.left));
      k = shown(rects[0]) >= shown(rects[rects.length - 1]) ? 0 : rects.length - 1;
    }
    const keep = pages[k];
    const R = rects[k];
    const n = +keep.dataset.page;
    const old = keep.querySelector('canvas');
    this.busy = true;
    this.#closePopup();
    this.#clearHighlights();
    const ghosts = pages.filter((p) => p !== keep).map((p) => this.#ghost(p, rects[pages.indexOf(p)]));
    keep.remove(); // keep its picture: the layout change frees what's left in the book
    this.focus = true;
    this.forcePage = n;
    this.#layout();
    const cam = this.camera;
    const stripLeft = (this.W - this.pw) / 2;
    const s = R.width / this.pw;
    cam.free = true;
    cam.set(s, R.left - stripLeft * s, R.top - this.#pageTop(n) * s);
    cam.flush();
    this.#syncStrip();
    this.#adopt(n, old);
    releaseCanvas(old);
    // Then settle: centred if the page is narrower than the screen.
    const fs = Math.min(MAX_ZOOM, s);
    const to = cam.clamp(fs, fs * this.pw <= this.W ? (this.W - this.pw * fs) / 2 - stripLeft * fs : cam.tx, cam.ty, true);
    requestAnimationFrame(() => ghosts.forEach((g) => (g.style.opacity = '0')));
    await cam.animateTo(to.s, to.tx, to.ty, FOCUS_MS);
    cam.free = false;
    setTimeout(() => this.#drop(ghosts), 120);
    this.busy = false;
    this.spread = this.#stripCurrent() - 1;
    this.#afterMove();
  }

  /**
   * One page → spread, keeping the zoom: the spread takes over beneath the
   * page at exactly its current size and place, its partner fades in beside
   * it, and the view only eases as far as needed to keep the book on screen.
   * Zooming out further from there is an ordinary spread zoom.
   * With `reset` (double tap) it then eases all the way out to the spread.
   */
  async #leaveFocus({ reset = false } = {}) {
    const cam = this.camera;
    const { W, H } = this;
    const n = this.#pageAtY((H / 2 - cam.ty) / cam.s);
    const keepSlot = this.stripPages.get(n);
    const keepPage = keepSlot && keepSlot.querySelector('.page');
    if (!keepPage) return;
    const R = this.#rectLocal(keepPage.getBoundingClientRect());
    const old = keepPage.querySelector('canvas');
    this.busy = true;
    this.#closePopup();
    this.#clearHighlights();
    keepSlot.remove(); // keep its picture: the layout change frees what's left in the strip
    this.stripPages.delete(n);
    this.focus = false;
    this.forcePage = n;
    this.#layout();
    // The page's place in the spread, at zoom 1 (content coordinates).
    const sp = spreadPages('double', this.spread, this.total);
    const isRight = sp.right === n;
    const book = this.#bookRect();
    const x0 = book.left + (isRight ? this.pw : 0);
    const y0 = book.top;
    this.#adopt(n, old);
    this.#drop([keepSlot]);
    // The partner page (and the spine shading) fade in beside it.
    const partnerSide = isRight ? 'left' : 'right';
    const fading = [...this.bookEl.querySelectorAll(`:scope > .slot.${partnerSide}, :scope > .spine`)];
    for (const f of fading) f.style.opacity = '0';
    const partnerPage = this.bookEl.querySelector(`:scope > .slot.${partnerSide} .page`);
    Promise.race([partnerPage ? partnerPage.painted : null, new Promise((r) => setTimeout(r, 250))]).then(() => {
      for (const f of fading) {
        f.style.transition = `opacity ${FOCUS_MS}ms ease`;
        f.style.opacity = '1';
      }
      setTimeout(() => fading.forEach((f) => (f.style.transition = f.style.opacity = '')), FOCUS_MS + 50);
    });
    // Same size, same place as a moment ago.
    const s = R.width / this.pw;
    cam.free = true;
    cam.set(s, R.left - x0 * s, R.top - y0 * s);
    cam.flush();
    const to = reset ? cam.clamp(1, 0, 0, true) : cam.clamp(s, cam.tx, cam.ty, true);
    await cam.animateTo(to.s, to.tx, to.ty, reset ? FOCUS_MS + 60 : FOCUS_MS);
    cam.free = false;
    this.busy = false;
    this.#afterMove();
  }

  #wheel(e) {
    e.preventDefault();
    this.userMovedAt = performance.now();
    const cam = this.camera;
    const p = this.#local(e);
    if (e.ctrlKey) {
      cam.stop();
      const floor = this.focus ? this.#focusFloor() * 0.8 : 1;
      cam.zoomAround(p.x, p.y, Math.max(floor, Math.min(MAX_ZOOM, cam.s * Math.exp(-e.deltaY * 0.01))));
      // Like letting go of a pinch, once the wheel rests.
      clearTimeout(this.wheelZoomTimer);
      this.wheelZoomTimer = setTimeout(() => this.#zoomSettled(p), 260);
      return;
    }
    if (this.mode === 'single' || cam.zoomed) {
      cam.stop();
      return cam.panBy(-e.deltaX, -e.deltaY);
    }
    const now = performance.now();
    if (Math.abs(e.deltaY) > 15 && now - (this.lastWheel || 0) > 500) {
      this.lastWheel = now;
      this.step(Math.sign(e.deltaY));
    }
  }

  #tap(ptr) {
    if (this.placing) return this.#placeAt(ptr);
    // Side arrows
    if (ptr.zone === 'arrow-next' || ptr.zone === 'arrow-prev') {
      const visible = this.el.classList.contains('arrows-on');
      if (visible || this.settings.singleTapArrows) this.step(ptr.zone === 'arrow-next' ? 1 : -1);
      this.#showArrows();
      return;
    }
    // Hidden toolbar comes back with a tap where it lives.
    if (!this.el.classList.contains('chrome-on') && this.#inChromeZone(ptr)) return this.#showChrome();

    const now = performance.now();
    const last = this.lastTap;
    if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(ptr.cx0 - last.x, ptr.cy0 - last.y) < 32) {
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      return this.#doubleTapZoom(ptr.x0, ptr.y0);
    }
    this.lastTap = { t: now, x: ptr.cx0, y: ptr.cy0 };
    clearTimeout(this.tapTimer);
    const link = this.#linkAt(ptr.cx0, ptr.cy0);
    this.tapTimer = setTimeout(() => {
      this.lastTap = null;
      // A single tap on a link follows it (a double tap still zooms).
      if (link && link.isConnected) return this.#followLink(link);
      if (this.el.classList.contains('chrome-on')) this.#hideChrome();
      else this.#showChrome();
    }, TAP_MS);
  }

  // ------------------------------------------------------------------ highlights
  // Highlights live inside the camera, in content coordinates, so they move
  // and scale with the page while panning and zooming.

  #textLayers() {
    const root = this.mode === 'single' ? this.stripEl : this.bookEl;
    return [...root.querySelectorAll('.slot .textLayer')];
  }

  #drawHighlights(rects, cls) {
    // Rectangles were measured from what is on screen: use the view that is
    // on screen too, not one still waiting for the next frame (mid-animation
    // these differ, and the mark would land in the wrong place).
    const cam = this.camera.shown || this.camera;
    clearTimeout(this.findFade);
    this.hlLayer.replaceChildren(
      ...rects.map((r) => {
        const l = this.#rectLocal(r);
        const d = document.createElement('div');
        d.className = `hl ${cls}`;
        Object.assign(d.style, {
          left: `${(l.left - cam.tx) / cam.s - 1}px`,
          top: `${(l.top - cam.ty) / cam.s - 1}px`,
          width: `${l.width / cam.s + 2}px`,
          height: `${l.height / cam.s + 2}px`,
        });
        return d;
      }),
    );
  }

  /** In landscape a page turn invalidates highlights; keep the read-aloud one in portrait. */
  #clearHighlights(onlyIfStale = false) {
    if (onlyIfStale && this.mode === 'single' && this.speech.active) return;
    this.hlLayer.replaceChildren();
  }

  // ------------------------------------------------------------------ word translation

  async #lookupWord(x, y) {
    const spans = collectSpans(this.#textLayers());
    const pos = hitTest(spans, x, y, { mode: 'char', maxDist: 6 });
    const word = pos && wordAt(spans, pos);
    if (!word) return;
    this.wordSel = { spans, a: word.a, b: word.b };
    this.#translateSelection();
  }

  /** Translate the current word selection (one word, or several after dragging the handles). */
  /** Punctuation directly after the selection's end (a full stop, comma, closing quote…). */
  #trailingPunctuation(spans, a, b) {
    const end = a.index > b.index || (a.index === b.index && a.offset > b.offset) ? a : b;
    let rest = spans[end.index].textContent.slice(end.offset);
    if (!rest && spans[end.index + 1]) rest = spans[end.index + 1].textContent;
    const m = /^[.,!?;:…"”’'»)\]]+/.exec(rest);
    return m ? m[0] : '';
  }

  // ---- comics: the words in a speech bubble, read from the picture

  /** Press and hold on a comic page: find the bubble there, read it, then translate it as a phrase. */
  async #readBubble(cx, cy) {
    const pageEl = (document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : []).find((el) => el.matches && el.matches('.page[data-page]'));
    if (!pageEl) return;
    const page = await this.doc.getPage(+pageEl.dataset.page);
    const src = page.source && (await page.source());
    if (!src) return;
    const r = pageEl.getBoundingClientRect();
    const u = (cx - r.left) / r.width;
    const v = (cy - r.top) / r.height;
    const { box } = src;
    if (u < box.x || u > box.x + box.w || v < box.y || v > box.y + box.h) return;
    const ix = src.sx + ((u - box.x) / box.w) * src.sw;
    const iy = ((v - box.y) / box.h) * src.ih;
    const lang = (this.book.comic && this.book.comic.ocr) || 'en';
    const req = (this.popReq = (this.popReq || 0) + 1);
    const point = this.lock.rectToLocal({ left: cx - 1, top: cy - 1, width: 2, height: 2, right: cx + 1, bottom: cy + 1 });
    this.ocrAt = { cx, cy };
    this.popWord = null;
    clearTimeout(this.popCloseTimer);
    const { readAt } = await import('../comic/ocr.js');
    this.#renderPopup(point, { word: '', loading: true, ocr: { lang, status: this.ocrReady ? 'Reading the bubble…' : 'Getting text recognition ready…' } });
    let res;
    try {
      res = await readAt(src.img, { sx: src.sx, sw: src.sw, ix, iy, lang, names: this.doc.names || (this.doc.names = new Map()) });
      this.ocrReady = true;
    } catch (e) {
      console.warn('text recognition', e);
      if (req === this.popReq && !this.pop.hidden) this.#renderPopup(point, { word: '', error: true, ocr: { lang, status: navigator.onLine === false && !this.ocrReady ? 'Text recognition needs the internet the first time.' : 'Couldn’t read this bubble.' } });
      return;
    }
    if (req !== this.popReq || this.pop.hidden) return;
    // The bubble, marked on the page.
    const bx = r.left + (box.x + ((res.box.x - src.sx) / src.sw) * box.w) * r.width;
    const by = r.top + (box.y + (res.box.y / src.ih) * box.h) * r.height;
    const bw = (res.box.w / src.sw) * box.w * r.width;
    const bh = (res.box.h / src.ih) * box.h * r.height;
    const rect = { left: bx, top: by, width: bw, height: bh, right: bx + bw, bottom: by + bh };
    const anchor = this.lock.rectToLocal(rect);
    if (!res.text || res.text.replace(/[^\p{L}\p{N}]/gu, '').length < 2) {
      if (res.bubble) this.#drawHighlights([rect], 'bubble');
      this.#renderPopup(anchor, { word: '', error: true, ocr: { lang, status: 'No words found here. Press and hold inside a speech bubble.' } });
      return this.#armPopupClose();
    }
    // The words go into the page's text layer: from here on they're text like any other.
    const n = +pageEl.dataset.page;
    const bi = this.doc.addBubble(n, { box: res.box, lines: res.lines, text: res.text });
    await this.#refreshOcrLayers(n);
    if (req !== this.popReq) return;
    // Held on a word: that word (drag the handles for more). Held elsewhere in the bubble: all of it.
    const spans = collectSpans(this.#textLayers());
    const pos = hitTest(spans, cx, cy, { mode: 'char', maxDist: 4 });
    const word = pos && wordAt(spans, pos);
    if (word && spans[word.a.index].dataset.bubble === String(bi)) {
      this.wordSel = { spans, a: word.a, b: word.b };
    } else {
      const mine = spans.map((s, i) => (s.closest('.page') === pageEl && s.dataset.bubble === String(bi) ? i : -1)).filter((i) => i >= 0);
      if (!mine.length) return this.#translateText(res.text, anchor, { ocr: { lang } }, req);
      const last = mine[mine.length - 1];
      this.wordSel = { spans, a: { index: mine[0], offset: 0 }, b: { index: last, offset: spans[last].textContent.length } };
    }
    this.#translateSelection();
  }

  /** Lay the words read on page n into its text layer(s) again (after more of them were read). */
  async #refreshOcrLayers(n) {
    const page = await this.doc.getPage(n);
    const layers = [...this.el.querySelectorAll(`.slot .page[data-page="${n}"] .textLayer`)];
    await Promise.all(layers.map((tl) => page.buildTextLayer(tl, tl.clientWidth || this.pw)));
  }

  /** Whether this comic's bubbles are read right to left: its own choice, else the way its pages turn. */
  #bubblesRtl() {
    const b = this.book.comic && this.book.comic.bubbles;
    return b ? b === 'rtl' : this.rtl;
  }

  /** Read the bubbles the other way: kept for the book, and the pages already read put in that order. */
  async #setBubbleOrder(v) {
    this.book.comic = Object.assign({}, this.book.comic, { bubbles: v === 'rtl' ? 'rtl' : 'ltr' });
    updateBook(this.book.id, { comic: this.book.comic });
    const { inReadingOrder } = await import('../comic/ocr.js');
    for (const [n, e] of this.doc.ocr) {
      if (!e.whole) continue;
      const o = (this.ocrOrder && this.ocrOrder.get(n)) || {};
      this.doc.setPageText(n, inReadingOrder(e.bubbles.slice(), this.#bubblesRtl(), o.panels, o.geo));
      this.#refreshOcrLayers(n);
    }
  }

  /** The language the bubbles of this comic are read in. */
  #ocrLang() {
    return (this.book.comic && this.book.comic.ocr) || 'en';
  }

  /**
   * Every bubble of page n, read (once): for drag-to-read and reading on in comics.
   * Says how far it has got in the read-aloud bar while the bar waits.
   */
  /** A page's bubbles, read (once: asking again while it is being read waits for that). */
  #ocrPage(n) {
    const running = this.ocrRunning || (this.ocrRunning = new Map());
    if (!running.has(n)) running.set(n, this.#readOcrPage(n).finally(() => running.delete(n)));
    return running.get(n);
  }

  async #readOcrPage(n) {
    const have = this.doc.ocr.get(n);
    if (have && have.whole) return;
    const page = await this.doc.getPage(n);
    const src = page.source && (await page.source());
    if (!src) return;
    const { readPage, inReadingOrder, whileBusy } = await import('../comic/ocr.js');
    // Recognition steps aside while you touch the screen, the view moves or a page turns.
    whileBusy(() => !!(this.ptr || this.pinch || this.busy || this.camera.raf || this.camera.moving || performance.now() - (this.userMovedAt || 0) < 500));
    const note = (t) => {
      const bar = this.el.querySelector('.tts-bar');
      if (this.readMode && bar.dataset.state === 'ready') bar.querySelector('.tts-label').textContent = t;
    };
    note(this.ocrReady ? 'Finding the words on the page…' : 'Getting text recognition ready…');
    let list;
    try {
      list = await readPage(src.img, { sx: src.sx, sw: src.sw, lang: this.#ocrLang(), rtl: this.#bubblesRtl(), names: this.doc.names || (this.doc.names = new Map()) }, (done, total) => total && note(`Reading the bubbles… ${done} of ${total}`));
      this.ocrReady = true;
    } catch (e) {
      console.warn('text recognition', e);
      note('Couldn’t read the words on this page.');
      return;
    }
    (this.panels || (this.panels = new Map())).set(n, list.panels || []);
    (this.ocrOrder || (this.ocrOrder = new Map())).set(n, { panels: list.panels, geo: list.geo });
    // Bubbles read by pressing on them that the page search missed stay too.
    const before = ((this.doc.ocr.get(n) || {}).bubbles || []).filter((b) => !list.some((x) => this.#overlaps(x.box, b.box)));
    this.doc.setPageText(n, inReadingOrder(list.concat(before), this.#bubblesRtl(), list.panels, list.geo));
    await this.#refreshOcrLayers(n);
    if (this.readMode) this.#onSpeechState(this.speech.state); // the bar's own words again
  }

  #overlaps(p, q) {
    const x = Math.max(0, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x));
    const y = Math.max(0, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y));
    return x * y > 0.4 * Math.min(p.w * p.h, q.w * q.h);
  }

  /** The pages on screen now. */
  #pagesOnScreen() {
    const box = this.el.getBoundingClientRect();
    return [...this.el.querySelectorAll('.slot .page[data-page]')]
      .filter((p) => {
        const r = p.getBoundingClientRect();
        return r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right;
      })
      .map((p) => +p.dataset.page)
      .filter((n, i, all) => all.indexOf(n) === i);
  }

  /** In read-aloud mode in a comic: the bubbles of the pages on screen are read, ready to be selected or read on from. */
  async #ocrOnScreen() {
    if (this.kind !== 'comic' || !this.readMode || this.ocrPaging) return;
    this.ocrPaging = true;
    try {
      for (const n of this.#pagesOnScreen()) await this.#ocrPage(n);
    } finally {
      this.ocrPaging = false;
    }
  }

  /** The words of a bubble (or any text) in the translation bubble. */
  async #translateText(text, anchor, extra = {}, req = (this.popReq = (this.popReq || 0) + 1)) {
    const target = this.settings.translateTo;
    this.popWord = { text, query: text, lang: guessLang(text) };
    this.#renderPopup(anchor, Object.assign({ word: text, loading: true }, extra));
    try {
      let res = await translate(text, target);
      if (res.source && res.source.split('-')[0] === target.split('-')[0] && target !== 'en') res = await translate(text, 'en');
      if (req !== this.popReq || this.pop.hidden) return;
      if (res.source) this.popWord.lang = res.source === 'he' ? 'iw' : res.source;
      this.#renderPopup(anchor, Object.assign({ word: text, result: res }, extra));
    } catch {
      if (req !== this.popReq || this.pop.hidden) return;
      this.#renderPopup(anchor, Object.assign({ word: text, error: true }, extra));
    }
    if (!extra.ocr) this.#armPopupClose(); // a bubble's words stay until you're done with them (tap to close)
  }

  async #translateSelection() {
    const { spans, a, b } = this.wordSel;
    const rects = rangeRects(spans, a, b);
    if (!rects.length) return;
    const text = rangeText(spans, a, b);
    // A phrase translates better with the punctuation that ends it ("Lilia."
    // reads as a whole sentence); the highlight stays on the words.
    const tail = /\s/.test(text) ? this.#trailingPunctuation(spans, a, b) : '';
    const query = text + tail;
    this.#drawHighlights(rects, 'word');
    this.#placeHandles(rects);
    const anchor = this.lock.rectToLocal(rects[0]);
    const target = this.settings.translateTo;
    const req = (this.popReq = (this.popReq || 0) + 1);
    this.popWord = { text, query, lang: guessLang(text) };
    clearTimeout(this.popCloseTimer);
    this.#renderPopup(anchor, { word: text, loading: true });
    try {
      let res = await translate(query, target);
      // Already in the target language → show English instead.
      if (res.source && res.source.split('-')[0] === target.split('-')[0] && target !== 'en') {
        res = await translate(query, 'en');
      }
      if (req !== this.popReq || this.pop.hidden) return;
      if (res.source) this.popWord.lang = res.source === 'he' ? 'iw' : res.source;
      this.#renderPopup(anchor, { word: text, result: res });
      this.#armPopupClose(); // a fresh countdown for every new translation
    } catch {
      if (req === this.popReq && !this.pop.hidden) {
        this.#renderPopup(anchor, { word: text, error: true });
        this.#armPopupClose();
      }
    }
  }

  // ---- selection handles: drag to include neighbouring words

  #placeHandles(rects) {
    if (!this.handles) {
      this.handles = ['start', 'end'].map((which) => {
        const h = document.createElement('div');
        h.className = `sel-handle ${which}`;
        h.setAttribute('aria-hidden', 'true');
        h.addEventListener('pointerdown', (e) => this.#handleDown(e, which));
        this.el.append(h);
        return h;
      });
    }
    const first = this.lock.rectToLocal(rects[0]);
    const last = this.lock.rectToLocal(rects[rects.length - 1]);
    const [hs, he] = this.handles;
    Object.assign(hs.style, { left: `${first.left}px`, top: `${first.top}px`, height: `${first.height}px` });
    Object.assign(he.style, { left: `${last.left + last.width}px`, top: `${last.top}px`, height: `${last.height}px` });
    hs.hidden = he.hidden = false;
  }

  /**
   * While a selection is being dragged out, a finger near an edge of the screen scrolls the view
   * that way (faster the nearer the edge), and the selection follows on to what comes into view.
   * Each move of the finger updates where it is; `step(x, y)` grows the selection after each scroll.
   */
  #edgeScroll(x, y, step) {
    const p = this.#local({ clientX: x, clientY: y });
    const W = this.camera.W || this.W;
    const H = this.camera.H || this.H;
    const zone = Math.max(36, Math.min(72, Math.min(W, H) * 0.1));
    // How hard to push each way: 0 outside the zone, 1 at (or nearly at) the edge.
    const push = (d) => Math.max(0, Math.min(1, (zone - d) / (zone * 0.8)));
    const vx = push(p.x) - push(W - p.x);
    const vy = push(p.y) - push(H - p.y);
    if (!vx && !vy) return this.#stopEdgeScroll();
    const es = this.edgeScrolling || (this.edgeScrolling = {});
    Object.assign(es, { x, y, step, vx, vy });
    if (es.raf) return;
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(48, now - last) / 16.7;
      last = now;
      // (Speed eases in: slow at the zone's edge, up to about a screen a second at the very edge.)
      const v = (k) => Math.sign(k) * k * k * Math.max(W, H) * 0.017 * dt;
      const cam = this.camera;
      cam.stop();
      const moved = cam.panBy(v(es.vx), v(es.vy));
      if (moved) {
        cam.flush();
        this.userMovedAt = now;
        es.step(es.x, es.y);
        if (this.wordSel && this.handles) this.#placeHandles(rangeRects(this.wordSel.spans, this.wordSel.a, this.wordSel.b));
      }
      es.raf = requestAnimationFrame(frame);
    };
    es.raf = requestAnimationFrame(frame);
  }

  #stopEdgeScroll() {
    const es = this.edgeScrolling;
    if (es && es.raf) cancelAnimationFrame(es.raf);
    this.edgeScrolling = null;
  }

  #hideHandles() {
    if (this.handles) for (const h of this.handles) h.hidden = true;
    this.handleDrag = null;
  }

  #handleDown(e, which) {
    if (e.button > 0 || !this.wordSel) return;
    e.stopPropagation();
    e.preventDefault();
    clearTimeout(this.popCloseTimer); // no closing while the selection is being adjusted
    const r = this.handles[which === 'start' ? 0 : 1].getBoundingClientRect();
    // Aim at the middle of the text line, not at the finger (which sits on the knob).
    this.handleDrag = { which, id: e.pointerId, dy: r.top + r.height / 2 - e.clientY, changed: false };
    this.pop.classList.add('adjusting');
  }

  #handleMove(e) {
    const d = this.handleDrag;
    if (!d || e.pointerId !== d.id) return;
    const sel = this.wordSel;
    this.#edgeScroll(e.clientX, e.clientY, (x, y) => this.handleDrag === d && this.#handleMove({ pointerId: d.id, clientX: x, clientY: y, scrolled: true }));
    const pos = hitTest(sel.spans, e.clientX, e.clientY + d.dy, { mode: 'char', maxDist: 40 });
    const w = pos && selectableAt(sel.spans, pos);
    if (!w) return;
    let { a, b } = sel;
    if (d.which === 'start') a = before(w.a, b) ? w.a : a;
    else b = before(a, w.b) ? w.b : b;
    if (same(a, sel.a) && same(b, sel.b)) return;
    sel.a = a;
    sel.b = b;
    d.changed = true;
    const rects = rangeRects(sel.spans, a, b);
    this.#drawHighlights(rects, 'word');
    this.#placeHandles(rects);
  }

  #handleUp(e) {
    const d = this.handleDrag;
    if (!d || e.pointerId !== d.id) return;
    this.handleDrag = null;
    this.#stopEdgeScroll();
    this.pop.classList.remove('adjusting');
    if (d.changed) this.#translateSelection();
    else this.#armPopupClose();
  }

  #renderPopup(anchor, { word, loading, result, error, ocr }) {
    if (!ocr && this.kind === 'comic') ocr = { lang: this.#ocrLang() }; // words from a comic: their language can be changed
    const pop = this.pop;
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const tl = result ? esc(result.text) : '';
    const alts = result?.alternatives?.length
      ? `<div class="pop-alts">${result.alternatives
          .slice(0, 2)
          .map((a) => `<span dir="auto"><em>${esc(a.pos || '')}</em> ${a.terms.map(esc).join(', ')}</span>`)
          .join('')}</div>`
      : '';
    const rtl = result ? isRtl(this.settings.translateTo) : false;
    // A different word or phrase in the bubble: the old one stops sounding.
    if (this.popSound && this.popSound.word !== word) {
      this.popSound = null;
      stopPronounce();
    }
    pop.classList.toggle('phrase', /\s/.test(word) || !!ocr);
    pop.classList.toggle('ocr', !!ocr);
    // A comic bubble: which language its words are in (read again on a change).
    const langs = ocr
      ? `<div class="pop-ocr" role="radiogroup" aria-label="Language of the bubbles">${[['en', 'English'], ['ja', '日本語'], ['ja-v', '日本語 縦']]
          .map(([v, l]) => `<button role="radio" data-act="popOcrLang" data-lang="${v}" aria-checked="${ocr.lang === v}">${l}</button>`)
          .join('')}</div>`
      : '';
    const status = ocr && ocr.status ? `<span class="muted">${esc(ocr.status)}</span>` : '';
    pop.innerHTML = `
      <div class="pop-main">
        ${word ? `<button class="pop-word" data-act="popSpeak" aria-label="Pronounce ${esc(word)}"><span class="pop-ico"><span class="ic-say">${icons.speaker}</span><span class="ic-stop">${icons.stop}</span><svg class="pop-ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="16"/></svg></span><span>${esc(word)}</span></button>` : ''}
        <div class="pop-tr" dir="${rtl ? 'rtl' : 'auto'}">${status && (loading || error) ? `${loading ? '<span class="dots"><i></i><i></i><i></i></span> ' : ''}${status}` : loading ? '<span class="dots"><i></i><i></i><i></i></span>' : error ? '<span class="muted">No connection</span>' : tl}</div>
      </div>
      ${alts}
      ${langs}
      ${
        word
          ? `<div class="pop-foot">
        <button class="pop-copy" data-act="popCopy" aria-label="Copy">${icons.copy}</button>
        <a class="pop-credit" data-google href="${esc(this.#googleUrl())}" target="_blank" rel="noopener">Open in <b>Google Translate</b> <span aria-hidden="true">↗</span></a>
      </div>`
          : ''
      }`;
    pop.hidden = false;
    this.#paintSound();
    const g = pop.querySelector('[data-google]');
    if (g) g.addEventListener('click', (e) => this.#openGoogle(e));
    // Position above the word, or below if there is no room.
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const cx = anchor.left + anchor.width / 2;
    const left = Math.max(12, Math.min(this.W - pw - 12, cx - pw / 2));
    let top = anchor.top - ph - 14;
    pop.dataset.below = top < 12 ? 'true' : 'false';
    if (top < 12) top = anchor.top + anchor.height + 14;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.setProperty('--arrow-x', `${Math.max(18, Math.min(pw - 18, cx - left))}px`);
  }

  /**
   * The pronounce button: a ring spins and fills around the speaker while the
   * sound loads; while it plays the button shows Stop; then it's a speaker
   * again (tap to hear it once more).
   */
  #paintSound() {
    const btn = this.pop.querySelector('.pop-word');
    const snd = this.popSound;
    if (!btn) return;
    const state = snd ? snd.state : 'idle';
    btn.classList.toggle('loading', state === 'loading');
    btn.classList.toggle('playing', state === 'playing');
    // The ring closes and fades once loading ends.
    btn.classList.toggle('loaded', state !== 'loading' && !!snd && snd.was === 'loading');
    btn.setAttribute('aria-label', state === 'playing' ? 'Stop' : `Pronounce ${btn.textContent.trim()}`);
  }

  /** Google Translate (website) with the selected text filled in. */
  #googleUrl() {
    const w = this.popWord;
    if (!w) return 'https://translate.google.com/';
    const tl = this.settings.translateTo || 'iw';
    return `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(tl)}&text=${encodeURIComponent(w.query || w.text)}&op=translate`;
  }

  /**
   * Hand the selection over to Google Translate. Android: straight into the
   * Translate app with the text (its website if the app isn't installed);
   * coming back is the Back gesture. Elsewhere the link opens Google
   * Translate (iOS passes it to the app when installed). The text is also
   * put on the clipboard, just in case. The bubble waits; see #onVisibility.
   */
  #openGoogle(e) {
    const w = this.popWord;
    if (!w) return;
    const text = w.query || w.text;
    clearTimeout(this.popCloseTimer);
    this.leftForGoogle = true; // back from Google Translate: the bubble has done its job
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    } catch (err) {}
    if (/Android/i.test(navigator.userAgent)) {
      e.preventDefault();
      location.href =
        'intent:#Intent;action=android.intent.action.SEND;type=text/plain;' +
        `S.android.intent.extra.TEXT=${encodeURIComponent(text)};` +
        'package=com.google.android.apps.translate;' +
        `S.browser_fallback_url=${encodeURIComponent(this.#googleUrl())};end`;
    }
    // Otherwise the link itself opens Google Translate in a new view.
  }

  /**
   * Leaving the app (e.g. for Google Translate) and coming back: save the
   * place and remember that this book is open (if the system closes the app
   * meanwhile, it reopens straight into the book); on return from Google
   * Translate the bubble is closed (otherwise its countdown starts again),
   * and full screen comes back with the next tap.
   */
  #onVisibility() {
    if (document.hidden) {
      clearTimeout(this.popCloseTimer);
      // Left the app straight after starting to scroll (a gesture to go Home, the system's
      // menus): the place is where it was before that scroll.
      const pan = this.lastPan;
      if (pan && performance.now() - pan.at < 1200) {
        this.camera.stop();
        this.camera.set(pan.from.s, pan.from.tx, pan.from.ty);
        this.camera.flush();
        this.lastPan = null;
        if (this.ptr && this.ptr.pan === pan) this.ptr = null;
      }
      if (this.mode) updateBook(this.book.id, { lastPage: this.#currentPage(), lastOpenedAt: Date.now() });
      try {
        localStorage.setItem(READING_KEY, JSON.stringify({ v: 2, id: this.book.id, at: Date.now(), view: this.mode ? this.#viewAnchor() : null }));
      } catch (err) {}
      return;
    }
    if (this.leftForGoogle) {
      this.leftForGoogle = false;
      this.#closePopup();
      this.#clearHighlights(true);
    } else if (!this.pop.hidden) this.#armPopupClose();
    if (this.settings.fullscreen && !fsElement()) this.refullscreen = true;
    // Back on screen while reading aloud (the screen was locked, or another app was in front):
    // catch up with the voice, showing the page and the sentence it is on now.
    if (this.aloud && this.speech.active && this.lastPiece != null) this.#onPiece(this.lastPiece);
  }

  /** Close the bubble by itself after the chosen delay (Settings; 0 = never). */
  #armPopupClose() {
    clearTimeout(this.popCloseTimer);
    this.popCloseTimer = null;
    if (this.popSound && this.popSound.state !== 'idle') return; // not while the word is sounding
    const secs = this.settings.popupSeconds;
    if (secs > 0) this.popCloseTimer = setTimeout(() => this.#closePopup(), secs * 1000);
  }

  #closePopup() {
    clearTimeout(this.popCloseTimer);
    this.popCloseTimer = null;
    this.#hideHandles();
    // Closing the bubble also stops its pronunciation.
    this.popSound = null;
    stopPronounce();
    if (this.pop.hidden) return;
    this.pop.hidden = true;
    this.popWord = null;
    this.wordSel = null;
    this.hlLayer.querySelectorAll('.hl.word').forEach((h) => h.remove());
  }

  // ------------------------------------------------------------------ read-aloud selection

  #enterReadMode() {
    // This runs inside the tap on the speaker button: unlock audio now, so
    // playback can start later when the selection is finished (iOS rules).
    this.speech.unlock();
    this.readMode = true;
    this.el.classList.add('read-mode');
    this.el.querySelector('[data-act="speak"]').classList.add('on');
    this.#onSpeechState(this.speech.state);
    this.#ocrOnScreen();
  }

  #exitReadMode() {
    this.readMode = false;
    this.sel = null;
    this.speech.stop(true);
    this.el.classList.remove('read-mode');
    this.el.querySelector('[data-act="speak"]').classList.remove('on');
    this.#clearHighlights();
    this.#onSpeechState('idle');
  }

  /** Begin a selection if the finger landed on text. Returns whether it did. */
  #selectStart(e) {
    const spans = collectSpans(this.#textLayers());
    const rects = spans.map((s) => s.getBoundingClientRect());
    const a = hitTest(spans, e.clientX, e.clientY, { mode: 'caret', maxDist: 14, rects });
    this.sel = a ? { spans, rects, a, b: a } : null;
    return !!a;
  }

  #selectMove(e) {
    if (!this.sel) return;
    const b = hitTest(this.sel.spans, e.clientX, e.clientY, { mode: 'caret', maxDist: 400, rects: this.sel.rects });
    if (!b) return;
    this.sel.b = b;
    this.#drawHighlights(rangeRects(this.sel.spans, this.sel.a, b), 'sel');
  }

  #selectEnd(e, cancelled) {
    const sel = this.sel;
    this.sel = null;
    if (cancelled || !sel) return this.#clearHighlights();
    const text = rangeText(sel.spans, sel.a, sel.b);
    if (text.length < 1) {
      this.#clearHighlights();
      return this.#toast('No text selected — this page may be a scanned image');
    }
    const lang = this.settings.speechLang === 'auto' ? guessLang(text) : this.settings.speechLang;
    this.aloud = null; // just this passage
    this.#setPicking(false);
    this.speech.speak(text, lang); // inside the gesture, so mobile browsers allow audio
  }

  // ---- continuous reading: from a tapped word on, page after page

  /** The text of page n as shown on screen, with the map back to its spans (null if not there yet). */
  #shownPageText(n) {
    const root = this.mode === 'single' ? this.stripEl : this.bookEl;
    const layer = root.querySelector(`.slot .page[data-page="${n}"] .textLayer`);
    const spans = layer ? collectSpans([layer]) : [];
    if (!spans.length) return null;
    return { spans, ...pageText(spans, layer.getBoundingClientRect(), { furniture: this.kind === 'epub' ? 'marks' : this.kind !== 'comic' }) };
  }

  /** The text of page n, read from a hidden text layer (pages not on screen yet). */
  async #pageTextOf(n) {
    const r = this.aloud;
    if (r.texts.has(n)) return r.texts.get(n);
    if (this.kind === 'comic') {
      await this.#ocrPage(n); // (a comic's words are read from its pictures first)
      // Reading on: the next page is read meanwhile, so the voice needn't wait at the page turn.
      if (this.aloud && n < this.total) this.#ocrPage(n + 1).catch(() => {});
    }
    const shown = this.#shownPageText(n);
    let text = shown ? shown.text : null;
    if (text == null) {
      const page = await this.cache.page(n);
      const box = document.createElement('div');
      box.className = 'page tts-scratch';
      box.style.width = `${this.pw}px`;
      box.style.height = `${this.ph}px`;
      const tl = document.createElement('div');
      tl.className = 'textLayer';
      box.append(tl);
      this.el.append(box);
      try {
        await buildTextLayer(page, tl, this.pw);
        text = pageText(collectSpans([tl]), tl.getBoundingClientRect(), { furniture: this.kind === 'epub' ? 'marks' : this.kind !== 'comic' }).text;
      } catch (e) {
        text = '';
      } finally {
        box.remove();
      }
    }
    r.texts.set(n, text);
    for (const k of r.texts.keys()) if (k < n - 2) r.texts.delete(k);
    return text;
  }

  /**
   * The next sentences to read (the speech player asks for more as it goes).
   * A sentence that runs on over a page break is read in one piece.
   */
  async #feedAloud(r) {
    if (r !== this.aloud) return null;
    for (let tries = 0; tries < 40; tries++) {
      if (r.page > this.total) return null;
      const text = await this.#pageTextOf(r.page);
      const ranges = sentenceRanges(text, r.offset);
      if (!ranges.length) {
        r.page++;
        r.offset = 0;
        continue;
      }
      const segs = ranges.map(([s, e]) => ({ parts: [{ page: r.page, s, e }], text: text.slice(s, e) }));
      const last = segs[segs.length - 1];
      const page = r.page;
      r.page++;
      r.offset = 0;
      // The page ends mid-sentence: finish the sentence from the next page (not in a comic: its
      // last bubble ends there).
      if (this.kind !== 'comic' && !/[.!?…]["'”’)\]]*$/.test(last.text) && page < this.total) {
        const next = await this.#pageTextOf(page + 1);
        const first = sentenceRanges(next, 0)[0];
        if (first && last.text.length + first[1] - first[0] < 185) {
          const tail = next.slice(first[0], first[1]);
          last.text = /[A-Za-z]-$/.test(last.text) ? last.text.slice(0, -1) + tail : `${last.text} ${tail}`;
          last.parts.push({ page: page + 1, s: first[0], e: first[1] });
          r.offset = first[1];
        }
      }
      if (r !== this.aloud) return null;
      r.segs.push(...segs);
      return segs.map((x) => x.text);
    }
    return null;
  }

  /** A tap on text in read-aloud mode: read from that word on. Returns whether it did. */
  #readFrom(ptr) {
    if (this.placing || !this.readMode || !this.settings.readContinuous || !this.#mayPick()) return false;
    const spans = collectSpans(this.#textLayers());
    const pos = hitTest(spans, ptr.cx0, ptr.cy0, { mode: 'char', maxDist: 14 });
    if (!pos) return false;
    const unit = selectableAt(spans, pos);
    const start = unit ? unit.a : pos;
    const span = spans[start.index];
    const pageEl = span.closest('.page');
    const n = pageEl && +pageEl.dataset.page;
    const shown = n && this.#shownPageText(n);
    if (!shown) return false;
    const local = shown.spans.indexOf(span);
    let k = shown.map.findIndex((m) => m && m.index === local && m.offset >= start.offset);
    if (k < 0) k = shown.map.findIndex((m) => m && m.index > local);
    if (k < 0) return false;
    const r = (this.aloud = { page: n, offset: k, segs: [], texts: new Map([[n, shown.text]]) });
    const lang = this.settings.speechLang === 'auto' ? guessLang(shown.text.slice(k, k + 400) || shown.text) : this.settings.speechLang;
    this.speech.speakFeed(() => this.#feedAloud(r), lang); // inside the tap, so mobile browsers allow audio
    this.#setPicking(false);
    return true;
  }

  /**
   * While reading on continuously, touching the text doesn't move the voice (you may be following
   * along by hand): "Read from another place" in the bar's panel arms the next tap or drag.
   */
  #mayPick() {
    return !this.aloud || this.speech.state === 'idle' || !!this.picking;
  }

  #setPicking(on) {
    this.picking = !!on;
    this.#paintTtsPanel();
    if (this.readMode && this.speech.state !== 'idle') this.#onSpeechState(this.speech.state); // the bar's words
  }

  /** The read-aloud bar's panel (continuous reading): shown or not, and its controls' states. */
  #paintTtsPanel() {
    const bar = this.el.querySelector('.tts-bar');
    const cont = !!this.aloud && bar.dataset.state !== 'ready';
    bar.classList.toggle('cont', cont);
    const panel = bar.querySelector('.tts-panel');
    panel.hidden = !(cont && this.ttsMore);
    bar.querySelector('[data-act="ttsMore"]').setAttribute('aria-expanded', String(!panel.hidden));
    panel.querySelector('[data-act="ttsFollow"]').setAttribute('aria-checked', String(this.settings.readFollow !== false));
    const pick = panel.querySelector('[data-act="ttsPick"]');
    pick.setAttribute('aria-pressed', String(!!this.picking));
    pick.textContent = this.picking ? 'Cancel' : 'Read from another place';
  }

  /** A sentence starts: show its page (turning pages as needed) and highlight it. */
  async #onPiece(i) {
    const r = this.aloud;
    const seg = r && r.segs[i];
    if (!seg) return;
    this.lastPiece = i;
    if (i > 12 && r.segs[i - 12]) r.segs[i - 12] = null; // keep only a little behind
    const token = (this.pieceToken = (this.pieceToken || 0) + 1);
    // Off screen (locked, or another app in front): nothing to show now; caught up on return.
    if (document.hidden) return;
    const n = seg.parts[0].page;
    if (this.settings.readFollow === false) {
      // Following by hand: just mark the sentence where it is.
      this.#markPiece({ piece: i, seg, page: n, started: performance.now(), rects: null, kept: true });
      return;
    }
    if (this.mode === 'double') {
      // A page turn still under way finishes first; then the spread with this sentence.
      for (let t = 0; t < 40 && this.busy && token === this.pieceToken; t++) await new Promise((res) => setTimeout(res, 80));
      if (token !== this.pieceToken) return;
      const shown = visiblePages(spreadPages('double', this.spread, this.total));
      if (!shown.includes(n)) await this.go(spreadOf('double', n));
    } else if (!this.#pageInView(n)) {
      this.#scrollToPage(n);
    }
    // The page's text layer may still be building after a turn.
    for (let t = 0; t < 30 && token === this.pieceToken && !this.#shownPageText(n); t++) await new Promise((res) => setTimeout(res, 100));
    if (token !== this.pieceToken || !this.speech.active) return;
    const rects = this.#markPiece({ piece: i, seg, page: n, started: performance.now(), rects: null, kept: false });
    this.cursor.rects = rects;
  }

  /** Where a part of the sentence being read is in its page's text as shown now: { shown, a, b }, or null. */
  #locatePart(part, shown = this.#shownPageText(part.page)) {
    if (!shown) return null;
    let s = part.s;
    let e = part.e;
    const want = this.aloud && this.aloud.texts.get(part.page);
    // Locate the sentence again if this page's text came out differently.
    if (want != null && shown.text !== want) {
      const at = shown.text.indexOf(want.slice(s, e));
      if (at < 0) return null;
      e = at + (e - s);
      s = at;
    }
    let a = s;
    while (a < e && !shown.map[a]) a++;
    let b = e - 1;
    while (b > a && !shown.map[b]) b--;
    if (a >= e || !shown.map[b]) return null;
    return { shown, a, b };
  }

  /** Mark the parts of the sentence being read that are on screen. Returns their rectangles. */
  #markPiece(next) {
    if (next) this.cursor = next;
    const c = this.cursor;
    if (!c) return [];
    const rects = [];
    for (const part of c.seg.parts) {
      const at = this.#locatePart(part);
      if (!at) continue;
      const end = { index: at.shown.map[at.b].index, offset: at.shown.map[at.b].offset + 1 };
      rects.push(...rangeRects(at.shown.spans, at.shown.map[at.a], end));
    }
    if (rects.length) this.#drawHighlights(rects, 'speak');
    return rects;
  }

  /**
   * Following the voice, every frame while it reads (where it is is estimated
   * from how far into the sentence's audio it has got, spread evenly over the
   * sentence's letters):
   *  - when it reaches the next page mid-sentence, that page is turned to (or
   *    scrolled to) right away, and the rest of the sentence marked there;
   *  - zoomed in, the view pans along each line in one continuous, even
   *    movement, timed to the voice: the line's start is near the left edge
   *    when the voice begins it and its end near the right edge when the voice
   *    gets there. A line that fits on screen isn't panned at all. Then a
   *    quick, smooth move to the start of the next line;
   *  - the place on the line is counted over the whole line, not the sentence,
   *    so a sentence that starts mid-line carries on from where the last one
   *    ended (no stepping back and forth between sentences);
   *  - the line being read is kept away from the top and bottom edges.
   * The view is moved by a soft spring towards where it should be, so it never
   * jumps and never stops abruptly. After you move the view yourself it waits a
   * moment before following again.
   */
  #followFrame(now) {
    this.followRaf = requestAnimationFrame((t) => this.#followFrame(t));
    const c = this.cursor;
    const cam = this.camera;
    const f = this.follow || (this.follow = { vx: 0, vy: 0, at: now, goalTy: null });
    const dt = Math.min(0.05, Math.max(0, (now - f.at) / 1000));
    f.at = now;
    const rest = () => {
      f.vx = 0;
      f.vy = 0;
      f.goalTy = null;
    };
    if (!c || document.hidden || this.busy || c.turning || cam.raf || now - (this.userMovedAt || 0) < 4000) return rest();
    if (this.settings.readFollow === false) return rest(); // following by hand
    if (this.kind === 'comic') {
      if (cam.s <= 1.02 && this.mode !== 'single') return rest(); // a whole spread is in view
      const goal = this.#panelGoal(c);
      return goal ? this.#springTo(f, goal.tx, goal.ty, dt, rest) : rest();
    }
    const frac = this.speech.progress();
    if (frac == null) {
      // A voice that can't say how far it is: bring the sentence into view once.
      if (!c.kept && now - c.started > 1500 && c.rects && c.rects.length) (c.kept = true), this.#keepInView(c.rects);
      return rest();
    }
    const parts = c.seg.parts;
    const total = parts.reduce((n, p) => n + Math.max(1, p.e - p.s), 0);
    let at = frac * total;
    let pi = 0;
    for (; pi < parts.length - 1; pi++) {
      const len = Math.max(1, parts[pi].e - parts[pi].s);
      if (at < len) break;
      at -= len;
    }
    const part = parts[pi];
    if (part.page !== c.page) return rest(), this.#voiceOnPage(c, part.page);
    const zoomed = cam.s > 1.02;
    if (!zoomed && this.mode !== 'single') return rest(); // a whole spread is in view
    const line = this.#voiceLine(c, pi, at);
    if (!line) return rest();
    const box = this.el.getBoundingClientRect();
    const shown = cam.shown || cam;
    const sign = this.rtl ? -1 : 1; // (a right-to-left comic's page area is mirrored)
    // Where the line is on screen now (measured when it was laid out, moved with the view since).
    const ox = sign * (shown.tx - line.tx);
    const oy = shown.ty - line.ty;
    const x0 = line.left + ox;
    const x1 = line.right + ox;
    const top = line.top + oy;
    const bottom = line.bottom + oy;
    let goalTx = shown.tx;
    if (zoomed) {
      const m = this.W * 0.07;
      const room = this.W - 2 * m;
      const w = x1 - x0;
      // Too long for the screen: pan from its start to its end as the voice goes along it.
      // Otherwise only keep all of it in sight.
      const want = w > room ? box.left + m - line.f * (w - room) : Math.min(Math.max(x0, box.left + m), box.left + m + room - w);
      goalTx = shown.tx + sign * (want - x0);
    }
    // Up and down: only when the line nears the top or bottom, then to about a third down.
    if (top < box.top + this.H * 0.1 || bottom > box.top + this.H * 0.85) f.goalTy = shown.ty + (box.top + this.H * 0.33 - top);
    const goalTy = f.goalTy == null ? shown.ty : f.goalTy;
    this.#springTo(f, goalTx, goalTy, dt, rest);
  }

  /** Move the view towards (goalTx, goalTy), a step of a soft spring (state in f). */
  #springTo(f, goalTx, goalTy, dt, rest) {
    const cam = this.camera;
    // Far away (the voice went on beyond what is in view): there in one quick move.
    if (Math.abs(goalTy - cam.ty) > this.H * 0.7 || Math.abs(goalTx - cam.tx) > this.W * 1.5) {
      rest();
      cam.animateTo(cam.s, goalTx, goalTy, 380);
      return;
    }
    // A critically damped spring: smooth start, no overshoot; along a line it follows the even pan closely.
    const w0 = 10;
    const ax = w0 * w0 * (goalTx - cam.tx) - 2 * w0 * f.vx;
    const ay = w0 * w0 * (goalTy - cam.ty) - 2 * w0 * f.vy;
    f.vx += ax * dt;
    f.vy += ay * dt;
    if (Math.abs(goalTx - cam.tx) < 0.3 && Math.abs(f.vx) < 2) f.vx = 0;
    if (Math.abs(goalTy - cam.ty) < 0.3 && Math.abs(f.vy) < 2) (f.vy = 0), (f.goalTy = null);
    if (!f.vx && !f.vy) return;
    const tx = cam.tx + f.vx * dt;
    const ty = cam.ty + f.vy * dt;
    cam.set(cam.s, tx, ty);
    // Held at an edge of the book: don't keep pushing.
    if (Math.abs(cam.tx - tx) > 0.5) f.vx = 0;
    if (Math.abs(cam.ty - ty) > 0.5) (f.vy = 0), (f.goalTy = null);
    cam.flush();
  }

  /**
   * A comic: where the view should be for the bubble being read. The whole of its panel when that
   * fits on screen; otherwise as much of the panel as fits, around the words, never past the
   * panel's edges (unless that would hide the words). Worked out once per bubble.
   */
  #panelGoal(c) {
    if (c.panelGoal) return c.panelGoal;
    if (!c.rects || !c.rects.length) return null;
    const cam = this.camera;
    const shown = cam.shown || cam;
    const box = this.el.getBoundingClientRect();
    const t = { l: Math.min(...c.rects.map((r) => r.left)), r: Math.max(...c.rects.map((r) => r.right)), t: Math.min(...c.rects.map((r) => r.top)), b: Math.max(...c.rects.map((r) => r.bottom)) };
    let p = null;
    const pageEl = (this.mode === 'single' ? this.stripEl : this.bookEl).querySelector(`.slot .page[data-page="${c.page}"]`);
    const panels = this.panels && this.panels.get(c.page);
    if (pageEl && panels && panels.length) {
      const pr = pageEl.getBoundingClientRect();
      const boxes = panels.map((q) => ({ l: pr.left + q.x0 * pr.width, r: pr.left + q.x1 * pr.width, t: pr.top + q.y0 * pr.height, b: pr.top + q.y1 * pr.height }));
      const cx = (t.l + t.r) / 2;
      const cy = (t.t + t.b) / 2;
      const area = (q) => Math.max(0, Math.min(q.r, t.r) - Math.max(q.l, t.l)) * Math.max(0, Math.min(q.b, t.b) - Math.max(q.t, t.t));
      p = boxes.filter((q) => cx >= q.l && cx <= q.r && cy >= q.t && cy <= q.b).sort((a, b) => (a.r - a.l) * (a.b - a.t) - (b.r - b.l) * (b.b - b.t))[0] || boxes.sort((a, b) => area(b) - area(a)).filter((q) => area(q) > 0)[0] || null;
    }
    if (!p) p = t;
    const m = Math.min(this.W, this.H) * 0.03;
    // Along one axis: how far to move the picture.
    const along = (lo, hi, a0, a1, v0, v1) => {
      const mid = (v0 + v1) / 2;
      let d = hi - lo <= v1 - v0 - 2 * m ? mid - (lo + hi) / 2 : Math.min(v0 - lo, Math.max(v1 - hi, mid - (a0 + a1) / 2));
      if (a1 - a0 <= v1 - v0 - 2 * m) d = Math.min(v1 - m - a1, Math.max(v0 + m - a0, d)); // the words stay in sight
      return d;
    };
    const dx = along(p.l, p.r, t.l, t.r, box.left, box.right);
    const dy = along(p.t, p.b, t.t, t.b, box.top, box.bottom);
    c.panelGoal = { tx: shown.tx + (this.rtl ? -dx : dx), ty: shown.ty + dy };
    return c.panelGoal;
  }

  /** The voice went on to the next page in the middle of the sentence: show it now. */
  async #voiceOnPage(c, page) {
    c.page = page;
    c.turning = true;
    try {
      if (this.mode === 'double') {
        if (!visiblePages(spreadPages('double', this.spread, this.total)).includes(page)) await this.go(spreadOf('double', page));
      } else if (!this.#shownPageText(page)) {
        // (Scrolling: a page whose words are there already is gone on to like the next line, below.)
        await this.#scrollToPage(page);
      }
      for (let t = 0; t < 20 && this.cursor === c && !this.#shownPageText(page); t++) await new Promise((res) => setTimeout(res, 100));
    } finally {
      c.turning = false;
    }
    if (this.cursor === c) c.rects = this.#markPiece();
  }

  /**
   * The line the voice is on, part `pi` of the sentence, `at` letters into it: its place on
   * screen (as measured, with the view's position then) and how far along the whole line the
   * voice is (0 to 1). The page's lines are measured once and kept until the page or zoom changes.
   */
  #voiceLine(c, pi, at) {
    const cam = this.camera;
    const shownCam = cam.shown || cam;
    const part = c.seg.parts[pi];
    let lay = c.layout && c.layout.page === part.page ? c.layout : null;
    if (lay && (lay.s !== shownCam.s || lay.W !== this.W || lay.H !== this.H || !lay.spans[0].isConnected)) lay = null;
    if (!lay) {
      const shown = this.#shownPageText(part.page);
      if (!shown) return null;
      lay = c.layout = { page: part.page, s: shownCam.s, W: this.W, H: this.H, tx: shownCam.tx, ty: shownCam.ty, spans: shown.spans, shown, lines: linesOf(shown), locs: [] };
    }
    if (!(pi in lay.locs)) lay.locs[pi] = this.#locatePart(part, lay.shown);
    const loc = lay.locs[pi];
    if (!loc) return null;
    const k = Math.min(loc.b, loc.a + at);
    const ki = Math.floor(k);
    let lo = 0;
    let hi = lay.lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lay.lines[mid].a <= ki) lo = mid;
      else hi = mid - 1;
    }
    const line = lay.lines[lo];
    if (!line) return null;
    return { ...line, tx: lay.tx, ty: lay.ty, f: Math.max(0, Math.min(1, (k - line.a) / Math.max(1, line.b + 1 - line.a))) };
  }

  /** Is any of page n on screen now (one-page scroll)? */
  #pageInView(n) {
    const root = this.mode === 'single' ? this.stripEl : this.bookEl;
    const el = root && root.querySelector(`.slot .page[data-page="${n}"]`);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const box = this.el.getBoundingClientRect();
    return r.bottom > box.top + 40 && r.top < box.bottom - 40;
  }

  /**
   * The sentence being read stays in sight: in one-page scroll it is brought to about a third
   * down the screen when it nears an edge; zoomed in, the view also moves sideways to its lines.
   */
  #keepInView(rects) {
    const cam = this.camera;
    const zoomed = cam.s > 1.02;
    if (this.mode !== 'single' && !zoomed) return; // a whole spread is in view
    const top = Math.min(...rects.map((x) => x.top));
    const bottom = Math.max(...rects.map((x) => x.bottom));
    const left = Math.min(...rects.map((x) => x.left));
    const right = Math.max(...rects.map((x) => x.right));
    const box = this.el.getBoundingClientRect();
    let dy = 0;
    let dx = 0;
    if (top < box.top + this.H * 0.12 || bottom > box.top + this.H * 0.82) dy = box.top + this.H * 0.3 - top;
    if (zoomed && (left < box.left + this.W * 0.04 || right > box.right - this.W * 0.04)) {
      // Wider than the screen: start of the lines in view; otherwise centred.
      dx = right - left > this.W * 0.92 ? box.left + this.W * 0.05 - left : box.left + this.W / 2 - (left + right) / 2;
    }
    if (this.rtl) dx = -dx; // (a right-to-left comic's page area is mirrored)
    if (dx || dy) cam.animateTo(cam.s, cam.tx + dx, cam.ty + dy, 500);
  }

  #onSpeechState(state) {
    const bar = this.el.querySelector('.tts-bar');
    const btn = bar.querySelector('[data-act="ttsToggle"]');
    if (state === 'idle') {
      cancelAnimationFrame(this.followRaf);
      this.followRaf = 0;
      this.cursor = null;
      if (this.speechWasActive) this.#clearHighlights();
      this.speechWasActive = false;
      // The bar stays while read-aloud mode is on, waiting for the next passage.
      bar.hidden = !this.readMode;
      bar.dataset.state = 'ready';
      // Waiting: say how to start, for the chosen way of reading.
      const on = !!this.settings.readContinuous;
      bar.querySelector('.tts-label').textContent = on ? 'Tap where to start reading' : 'Drag across a passage';
      bar.querySelector('[data-act="ttsMode"]').setAttribute('aria-checked', String(on));
      this.aloud = null;
      this.picking = false;
      this.#paintTtsPanel();
      this.#keepAwake(false);
      return;
    }
    this.speechWasActive = true;
    this.#keepAwake(true);
    if (!this.followRaf) this.followRaf = requestAnimationFrame((t) => this.#followFrame(t));
    bar.hidden = false;
    bar.dataset.state = state;
    btn.innerHTML = state === 'paused' ? icons.play : icons.pause;
    btn.setAttribute('aria-label', state === 'paused' ? 'Resume' : 'Pause');
    // Say so when the chosen voice couldn't be reached and another one is reading.
    const other = this.speech.fellBack ? (this.speech.usingFallback ? ' · device voice' : ' · Google voice') : '';
    const label = bar.querySelector('.tts-label');
    clearTimeout(this.ttsSlowTimer);
    this.#paintTtsPanel();
    if (this.picking) {
      label.textContent = 'Tap a word to read from, or drag across a passage';
      return;
    }
    if (state === 'loading') {
      // Taking a while (a weak signal, a busy voice service): keep saying what is happening.
      label.textContent = (navigator.onLine === false ? 'No connection · trying the device voice…' : 'Getting the voice ready…') + other;
      this.ttsSlowTimer = setTimeout(() => {
        if (bar.dataset.state === 'loading') label.textContent = 'Still getting the voice ready (slow connection)…';
      }, 6000);
      return;
    }
    label.textContent = (state === 'paused' ? 'Paused' : 'Reading aloud') + other;
  }

  /** Keep the screen on while reading aloud (where the browser allows it). */
  #keepAwake(on) {
    if (on && !this.wakeLock && navigator.wakeLock) {
      this.wakeLock = navigator.wakeLock.request('screen').catch(() => null);
    } else if (!on && this.wakeLock) {
      this.wakeLock.then((l) => l && l.release()).catch(() => {});
      this.wakeLock = null;
    }
  }

  // ------------------------------------------------------------------ teardown

  /** Before the pages are set again: where we are, and which tool panel is open. */
  handOver() {
    const page = this.#currentPage();
    return { saved: { lastPage: page, readingPos: this.returnTo ? this.readingPos : page }, panel: this.tools.panelKind || null };
  }

  destroy({ staying = false } = {}) {
    this.#stopEdgeScroll();
    clearTimeout(this.hideTimer);
    clearTimeout(this.arrowTimer);
    clearTimeout(this.tapTimer);
    clearTimeout(this.saveTimer);
    clearTimeout(this.hiResTimer);
    this.camera.stop();
    if (this.mode) updateBook(this.book.id, { lastPage: this.#currentPage(), lastOpenedAt: Date.now() });
    try {
      localStorage.removeItem(READING_KEY);
    } catch (err) {}
    // Full screen stays after the book closes: entering it again for the next book would make
    // Android show its "swipe to exit full screen" notice every time. (The full-screen button
    // in the reader still turns it off.)
    this.speech.stop(true);
    cancelAnimationFrame(this.followRaf);
    this.followRaf = 0;
    this.#keepAwake(false);
    this.tools.destroy();
    this.lock.destroy();
    this.thumbs.destroy();
    for (const fn of this.cleanups) fn();
    this.#drop([this.el]);
    this.cache.destroy();
    document.documentElement.classList.remove('reading');
    this.doc.destroy();
    if (this.kind === 'comic' && this.ocrReady) import('../comic/ocr.js').then((m) => m.closeOcr()); // its memory back
  }
}
