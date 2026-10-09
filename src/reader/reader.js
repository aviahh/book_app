// The reading view: layout, navigation, page turning, zoom & pan, toolbar,
// thumbnails, word translation, read-aloud selection and the orientation lock.
//
// Landscape ("double"): a book of facing pages, turned with a page curl.
// Portrait ("single"): pages stacked in a vertical strip and scrolled.
// Both can be pinch-zoomed and panned.
import { getBook, getBookFile, updateBook } from '../db.js';
import { openPdf, buildTextLayer, renderPageCanvas, releaseCanvas, canvasOk, ZOOM_PIXELS, LOW_MEMORY } from '../pdf.js';
import { getSettings, onSettingsChange } from '../settings.js';
import { icons } from '../icons.js';
import { Speech, translate, pronounce, stopPronounce, guessLang, isRtl } from '../google.js';
import { trackReading } from '../stats.js';
import { PageCache } from './pageCache.js';
import { Flipper } from './flipper.js';
import { FoldFlipper } from './foldFlipper.js';
import { BendFlipper } from './bendFlipper.js';
import { Camera } from './camera.js';
import { spreadCount, spreadOf, spreadPages, visiblePages, spreadLabel } from './spreads.js';
import { collectSpans, hitTest, wordAt, selectableAt, rangeRects, rangeText } from './textTools.js';
import { OrientationLock } from './orientation.js';
import { ThumbStrip } from './thumbs.js';

const TAP_MS = 300;
const DOUBLE_TAP_MS = 340;
const MOVE_SLOP = 10;
// Text positions { index, offset } (span, character): order and equality.
const before = (p, q) => p.index < q.index || (p.index === q.index && p.offset < q.offset);
const same = (p, q) => p.index === q.index && p.offset === q.offset;
const LONG_PRESS_MS = 450; // press and hold a word: translate it
const DOUBLE_TAP_ZOOM = 2.2; // where a double tap zooms to (when not going to one page)
const MAX_ZOOM = 4;
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
const TURNERS = { curl: Flipper, fold: FoldFlipper, bend: BendFlipper };

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
  const book = await getBook(id);
  if (!book) return nav('#/library');
  const blob = await getBookFile(id);
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

class Reader {
  constructor(root, book, doc, nav) {
    this.root = root;
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
    this.speech = new Speech({ onState: (s) => this.#onSpeechState(s), voice: () => this.settings.speechVoice });
    this.#build();
    this.camera = new Camera(this.cameraEl, () => this.#onCamera());
    this.lock = new OrientationLock(this.el, () => this.#layout());
    this.thumbs = new ThumbStrip(this.el.querySelector('.thumbstrip'), doc, {
      label: () => this.#label(),
      mode: () => this.mode,
      current: () => this.spread,
      go: (i) => this.go(i),
    });
    this.thumbs.cache.setTone(this.settings.pageTone);
    this.#bindInput();
    this.#loadChapters();
    // Keep the page itself still while reading (iOS likes to scroll/zoom it).
    document.documentElement.classList.add('reading');
    window.scrollTo(0, 0);
    this.cleanups.push(onSettingsChange((s) => this.#applySettings(s)));
    this.cleanups.push(trackReading(() => !document.hidden));
    this.#applySettings(this.settings);
    this.startPage = Math.min(book.lastPage || 1, this.total);
    this.#layout();
    this.#showChrome();
    updateBook(book.id, { lastOpenedAt: Date.now() });
  }

  // ------------------------------------------------------------------ DOM

  #build() {
    const el = (this.el = document.createElement('div'));
    el.className = 'reader';
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
        <span class="tts-label" aria-live="polite">Select a passage to read</span>
        <button data-act="ttsToggle" class="tts-btn" aria-label="Pause">${icons.pause}</button>
        <button data-act="ttsStop" class="tts-btn" aria-label="Stop">${icons.stop}</button>
        <span class="tts-sep"></span>
        <button data-act="ttsClose" class="tts-close" aria-label="Close read aloud">${icons.close}</button>
      </div>
      <div class="word-pop" hidden role="dialog" aria-label="Translation"></div>
      <div class="toast" hidden></div>
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
      const walk = async (items) => {
        for (const it of items || []) {
          try {
            let dest = it.dest;
            if (typeof dest === 'string') dest = await this.doc.getDestination(dest);
            const ref = dest && dest[0];
            const index = typeof ref === 'number' ? ref : ref ? await this.doc.getPageIndex(ref) : -1;
            if (index >= 0) starts.add(index + 1);
          } catch (e) {}
          await walk(it.items);
        }
      };
      await walk(outline);
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
    // The layout the screen calls for; zoomed into one page in landscape
    // ("focus"), the one-page scroll is used instead of the spread.
    const natural = this.lock.locked ? this.lock.lockedMode : W > H ? 'double' : 'single';
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
      const stripH = STRIP_PAD * 2 + this.total * (ph + STRIP_GAP) - STRIP_GAP;
      Object.assign(this.stripEl.style, { width: `${pw}px`, height: `${stripH}px`, left: `${(W - pw) / 2}px` });
      const m = Math.max(0, Math.min(16, (W - pw) / 2));
      this.camera.setBox({ x: (W - pw) / 2 - m, y: 0, w: pw + 2 * m, h: stripH });
      this.#scrollToPage(page, false);
      this.#syncStrip();
    }
    this.#updateZoomChip();
    this.#updateIndicator();
    if (modeChanged) this.thumbs.rebuild();
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
    this.go(spreadOf(this.mode, +el.dataset.page));
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

  #pageTop(n) {
    return STRIP_PAD + (n - 1) * (this.ph + STRIP_GAP);
  }

  #pageAtY(y) {
    return Math.max(1, Math.min(this.total, Math.floor((y - STRIP_PAD + STRIP_GAP / 2) / (this.ph + STRIP_GAP)) + 1));
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
      this.stripEl.append(slot);
      this.stripPages.set(n, slot);
    }
  }

  // ---- zoom quality

  #onCamera() {
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
    this.#updateIndicator();
    this.#saveProgress();
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
    // Still zoomed in? Start the new spread from its top-left corner.
    if (this.camera.zoomed) {
      const box = this.camera.box;
      this.camera.set(this.camera.s, -box.x * this.camera.s, -box.y * this.camera.s);
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
    const Turner = TURNERS[this.settings.pageTurn] || Flipper;
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
    const Turner = TURNERS[this.settings.pageTurn] || Flipper;
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
      if (e.target.closest?.('input')) return;
      const k = e.key;
      const portrait = this.mode === 'single';
      if (portrait && (k === 'ArrowDown' || k === ' ')) this.camera.animateTo(this.camera.s, this.camera.tx, this.camera.ty - this.H * 0.85, 300), e.preventDefault();
      else if (portrait && k === 'ArrowUp') this.camera.animateTo(this.camera.s, this.camera.tx, this.camera.ty + this.H * 0.85, 300), e.preventDefault();
      else if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') this.step(1), e.preventDefault();
      else if (k === 'ArrowLeft' || k === 'PageUp') this.step(-1), e.preventDefault();
      else if (k === 'Home') this.go(0);
      else if (k === 'End') this.go(this.spreadTotal - 1);
      else if (k === 'Escape') this.#closePopup();
    });

    const lostFingers = () => this.#resetPointers();
    on(window, 'blur', lostFingers);
    on(window, 'orientationchange', lostFingers);
    on(document, 'visibilitychange', () => document.hidden && lostFingers());

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
        return this.go(0);
      case 'last':
        return this.go(this.spreadTotal - 1);
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
      if (go && n >= 1 && n <= this.total) this.go(spreadOf(this.mode, n));
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
    return this.lock.toLocal(e.clientX, e.clientY);
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
    if (!this.pop.hidden && this.pointers.size === 0) {
      this.#closePopup();
      this.#clearHighlights();
      return;
    }
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
      return this.#pinchStart();
    }
    if (this.pointers.size > 1) return;

    this.camera.stop();
    this.ptr = { id: e.pointerId, x0: p.x, y0: p.y, lx: p.x, ly: p.y, cx0: e.clientX, cy0: e.clientY, t0: performance.now(), zone: forced || this.#zone(p) };
    // Read-aloud mode: a drag that starts on text selects it; anywhere else behaves as usual.
    if (this.readMode && this.#selectStart(e)) {
      this.ptr.selecting = true;
      e.preventDefault();
    }
    const ptr = this.ptr;
    clearTimeout(this.pressTimer);
    this.pressTimer = setTimeout(() => this.#longPress(ptr), LONG_PRESS_MS);
  }

  /** Forget every finger on the screen (and any gesture in progress). */
  #resetPointers() {
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
    if (ptr.pressed) return this.#extendFromPress(e, ptr, p);
    if (ptr.selecting) {
      if (Math.hypot(p.x - ptr.x0, p.y - ptr.y0) > MOVE_SLOP) ptr.moved = true;
      return ptr.moved && this.#selectMove(e);
    }
    const dx = p.x - ptr.x0;
    const dy = p.y - ptr.y0;
    if (Math.hypot(dx, dy) > MOVE_SLOP) ptr.moved = true;

    if (!ptr.drag && !ptr.pan && !ptr.chromeShown && ptr.moved) {
      if (this.mode === 'single' || this.camera.zoomed) {
        ptr.pan = { samples: [] };
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

  #inChromeZone(ptr) {
    const top = this.el.classList.contains('toolbar-top');
    return top ? ptr.y0 < 80 : ptr.y0 > this.H - 80;
  }

  async #up(e, cancelled = false) {
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
    if (ptr.pressed) {
      // The hold already translated; if the finger then dragged, translate the grown selection.
      if (ptr.extended && !cancelled) {
        this.pop.classList.remove('adjusting');
        this.#translateSelection();
      } else if (ptr.extended) this.pop.classList.remove('adjusting');
      return;
    }
    if (ptr.selecting) {
      // A plain tap on text is still a tap (toolbar / double-tap zoom).
      if (!ptr.moved) {
        this.sel = null;
        if (!cancelled && performance.now() - ptr.t0 < 600) this.#tap(ptr);
        return;
      }
      return this.#selectEnd(e, cancelled);
    }

    if (ptr.pan) {
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
    const rects = pages.map((p) => this.lock.rectToLocal(p.getBoundingClientRect()));
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
    const R = this.lock.rectToLocal(keepPage.getBoundingClientRect());
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
    const cam = this.camera;
    this.hlLayer.replaceChildren(
      ...rects.map((r) => {
        const l = this.lock.rectToLocal(r);
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
    this.popWord = { text, lang: guessLang(text) };
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
    this.pop.classList.remove('adjusting');
    if (d.changed) this.#translateSelection();
    else this.#armPopupClose();
  }

  #renderPopup(anchor, { word, loading, result, error }) {
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
    pop.classList.toggle('phrase', /\s/.test(word));
    pop.innerHTML = `
      <div class="pop-main">
        <button class="pop-word" data-act="popSpeak" aria-label="Pronounce ${esc(word)}"><span class="pop-ico"><span class="ic-say">${icons.speaker}</span><span class="ic-stop">${icons.stop}</span><svg class="pop-ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="16"/></svg></span><span>${esc(word)}</span></button>
        <div class="pop-tr" dir="${rtl ? 'rtl' : 'auto'}">${loading ? '<span class="dots"><i></i><i></i><i></i></span>' : error ? '<span class="muted">No connection</span>' : tl}</div>
      </div>
      ${alts}
      <div class="pop-foot">
        <button class="pop-copy" data-act="popCopy" aria-label="Copy word">${icons.copy}</button>
        <span class="pop-credit">translated by <b>Google</b></span>
      </div>`;
    pop.hidden = false;
    this.#paintSound();
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
    this.speech.speak(text, lang); // inside the gesture, so mobile browsers allow audio
  }

  #onSpeechState(state) {
    const bar = this.el.querySelector('.tts-bar');
    const btn = bar.querySelector('[data-act="ttsToggle"]');
    if (state === 'idle') {
      if (this.speechWasActive) this.#clearHighlights();
      this.speechWasActive = false;
      // The bar stays while read-aloud mode is on, waiting for the next passage.
      bar.hidden = !this.readMode;
      bar.dataset.state = 'ready';
      bar.querySelector('.tts-label').textContent = 'Select a passage to read';
      return;
    }
    this.speechWasActive = true;
    bar.hidden = false;
    bar.dataset.state = state;
    btn.innerHTML = state === 'paused' ? icons.play : icons.pause;
    btn.setAttribute('aria-label', state === 'paused' ? 'Resume' : 'Pause');
    // Say so when the chosen voice couldn't be reached and another one is reading.
    const other = this.speech.fellBack ? (this.speech.usingFallback ? ' · device voice' : ' · Google voice') : '';
    bar.querySelector('.tts-label').textContent = (state === 'loading' ? 'Preparing…' : state === 'paused' ? 'Paused' : 'Reading aloud') + other;
  }

  // ------------------------------------------------------------------ teardown

  destroy() {
    clearTimeout(this.hideTimer);
    clearTimeout(this.arrowTimer);
    clearTimeout(this.tapTimer);
    clearTimeout(this.saveTimer);
    clearTimeout(this.hiResTimer);
    this.camera.stop();
    if (this.mode) updateBook(this.book.id, { lastPage: this.#currentPage(), lastOpenedAt: Date.now() });
    // Leaving for Settings keeps full screen; leaving the book ends it.
    if (!location.hash.startsWith('#/settings')) exitFullscreen();
    this.speech.stop(true);
    this.lock.destroy();
    this.thumbs.destroy();
    for (const fn of this.cleanups) fn();
    this.#drop([this.el]);
    this.cache.destroy();
    document.documentElement.classList.remove('reading');
    this.doc.destroy();
  }
}
