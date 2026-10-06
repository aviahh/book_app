// The reading view: layout, navigation, page turning, zoom & pan, toolbar,
// thumbnails, word translation, read-aloud selection and the orientation lock.
//
// Landscape ("double"): a book of facing pages, turned with a page curl.
// Portrait ("single"): pages stacked in a vertical strip and scrolled.
// Both can be pinch-zoomed and panned.
import { getBook, getBookFile, updateBook } from '../db.js';
import { openPdf, buildTextLayer } from '../pdf.js';
import { getSettings, onSettingsChange } from '../settings.js';
import { icons } from '../icons.js';
import { Speech, translate, pronounce, guessLang, isRtl } from '../google.js';
import { trackReading } from '../stats.js';
import { PageCache } from './pageCache.js';
import { Flipper } from './flipper.js';
import { FoldFlipper } from './foldFlipper.js';
import { BendFlipper } from './bendFlipper.js';
import { Camera } from './camera.js';
import { spreadCount, spreadOf, spreadPages, visiblePages, spreadLabel } from './spreads.js';
import { collectSpans, hitTest, wordAt, rangeRects, rangeText } from './textTools.js';
import { OrientationLock } from './orientation.js';
import { ThumbStrip } from './thumbs.js';

const TAP_MS = 300;
const DOUBLE_TAP_MS = 340;
const MOVE_SLOP = 10;
const MAX_ZOOM = 4;
const STRIP_GAP = 14;
const STRIP_PAD = 18;
// Animated page-turn styles (landscape) → their engines.
const TURNERS = { curl: Flipper, fold: FoldFlipper, bend: BendFlipper };

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;

function enterFullscreen() {
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
    this.settings = getSettings();
    this.mode = null;
    this.spread = 0; // spread index (double) or page index (single)
    this.busy = false; // a page turn is animating
    this.renderZoom = 1;
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
    this.#bindInput();
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
    this.settings = s;
    this.el.dataset.backdrop = s.backdrop;
    this.el.dataset.tone = s.pageTone;
    this.el.classList.toggle('toolbar-top', s.toolbarPosition === 'top');
  }

  // ------------------------------------------------------------------ layout

  #currentPage() {
    return this.mode ? visiblePages(spreadPages(this.mode, this.spread, this.total))[0] : this.startPage;
  }

  #layout() {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (!W || !H) return;
    const mode = this.lock.locked ? this.lock.lockedMode : W > H ? 'double' : 'single';
    const aspect = this.book.aspect || 0.7;
    let pw;
    if (mode === 'double') {
      const vpad = Math.max(18, H * 0.035);
      const hpad = Math.max(56, W * 0.05);
      pw = Math.floor(Math.min((W - 2 * hpad) / 2, (H - 2 * vpad) * aspect));
    } else {
      // Portrait reads as a scroll of full-width pages.
      pw = Math.floor(Math.min(W - 2 * Math.max(10, W * 0.025), 1200));
    }
    const ph = Math.floor(pw / aspect);
    const changed = mode !== this.mode || pw !== this.pw || ph !== this.ph || W !== this.W || H !== this.H;
    if (!changed) return;
    const page = this.#currentPage();
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
    this.cache.setWidth(pw, { limit: 14, maxPixels: undefined });
    this.spread = spreadOf(mode, page);

    if (mode === 'double') {
      this.stripEl.replaceChildren();
      this.stripPages.clear();
      const w = pw * 2;
      this.bookEl.style.width = `${w}px`;
      this.bookEl.style.height = `${ph}px`;
      this.bookEl.style.perspective = `${Math.round(w * 2.2)}px`;
      this.camera.setBox({ x: (W - w) / 2, y: (H - ph) / 2, w, h: ph });
      this.camera.set(1, 0, 0);
      this.#renderSpread();
    } else {
      this.bookEl.replaceChildren();
      this.stripEl.replaceChildren();
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
    }
    return p;
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
      this.bookEl.replaceChildren(...els);
      return Promise.resolve();
    }
    this.bookEl.append(...els);
    const paints = els.flatMap((e) => [...e.querySelectorAll('.page')].map((p) => p.painted));
    const timeout = new Promise((r) => setTimeout(r, 450));
    return Promise.race([Promise.all(paints), timeout])
      .then(() => new Promise(requestAnimationFrame))
      .then(() => {
        for (const old of replace) old.remove();
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
        el.remove();
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

  /** After zooming settles, re-render visible pages sharp at the new size. */
  #hiRes() {
    if (this.pinch || this.busy) return (this.hiResTimer = setTimeout(() => this.#hiRes(), 260));
    const want = Math.min(3, Math.max(1, Math.round(this.camera.s * 2) / 2));
    if (want === this.renderZoom) return;
    this.renderZoom = want;
    this.cache.setWidth(this.pw * want, want > 1 ? { limit: 6, maxPixels: 16_000_000 } : { limit: 14, maxPixels: undefined });
    for (const c of this.cameraEl.querySelectorAll('.page canvas')) {
      const n = +c.parentElement.dataset.page;
      this.cache.paint(n, c, 0).catch(() => {});
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
    const style = animate ? this.settings.pageTurn : 'none';
    this.cache.demoteAll();
    if (TURNERS[style]) {
      const turn = this.#beginTurn(target > from ? 1 : -1, target);
      await turn.flip.animateTo(1, Math.abs(target - from) > 1 ? 620 : 680);
      await this.#endTurn(turn, true);
    } else if (style === 'slide') {
      await this.#slide(target > from ? 1 : -1, target);
    } else {
      this.spread = target;
      await this.#renderSpread(target, { replace: [...this.bookEl.children] });
    }
    // Zoomed in? Start the new spread from its top-left corner.
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
    for (const o of old) o.remove();
    for (const f of fresh) f.style.transition = '';
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
      onProgress: (t) => this.#setOffset(offFrom + (offTo - offFrom) * t),
    });
    const pages = [...under.flatMap((u) => [...u.querySelectorAll('.page')]), front, back].filter(Boolean);
    Promise.race([Promise.all(pages.map((p) => p.painted)), new Promise((r) => setTimeout(r, 300))]).then(() => {
      for (const o of old) o.remove();
    });
    this.turn = { flip, dir, from, target };
    return this.turn;
  }

  async #endTurn(turn, commit) {
    if (commit) this.spread = turn.target;
    await this.#renderSpread(this.spread, { replace: [...this.bookEl.children] });
    turn.flip.destroy();
    if (this.turn === turn) this.turn = null;
    this.busy = false;
  }

  #cancelTurn() {
    if (this.turn) {
      this.turn.flip.destroy();
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
    btn.hidden = !supported;
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
    on(window, 'pointermove', (e) => this.#move(e));
    on(window, 'pointerup', (e) => this.#up(e));
    on(window, 'pointercancel', (e) => this.#up(e, true));
    for (const a of el.querySelectorAll('.edge-arrow')) {
      on(a, 'pointerdown', (e) => this.#down(e, a.classList.contains('next') ? 'arrow-next' : 'arrow-prev'));
    }
    on(this.chrome, 'pointerdown', () => this.#armHide());
    on(this.pop, 'pointerdown', (e) => e.stopPropagation());
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

    const ro = new ResizeObserver(() => this.#layout());
    ro.observe(el);
    this.cleanups.push(() => ro.disconnect());
  }

  #action(act, btn) {
    this.#armHide();
    const s = this.settings;
    switch (act) {
      case 'close':
        return this.nav('#/library');
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
        return this.step(-s.jumpPages);
      case 'jumpFwd':
        return this.step(s.jumpPages);
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
      case 'popSpeak':
        return pronounce(this.popWord.text, this.popWord.lang);
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
    const locked = await this.lock.toggle(this.mode);
    btn.innerHTML = locked ? icons.locked : icons.lock;
    btn.classList.toggle('on', locked);
    btn.setAttribute('aria-pressed', String(locked));
    this.#toast(locked ? `Locked to ${this.mode === 'double' ? 'landscape' : 'portrait'}` : 'Orientation unlocked');
  }

  // Pointer state machine ----------------------------------------------------
  //
  // One finger: tap / double-tap, page-turn drag (landscape, not zoomed),
  // pan (portrait, or zoomed), or text selection (read-aloud mode).
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
  }

  #move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.#local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pinch) return this.#pinchMove();
    const ptr = this.ptr;
    if (!ptr || e.pointerId !== ptr.id) return;
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
    if (ptr.selecting) {
      // A plain tap on text is still a tap (toolbar / double-tap translation).
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
    const s = Math.max(0.8, Math.min(MAX_ZOOM * 1.15, (s0 * Math.hypot(a.x - b.x, a.y - b.y)) / d0));
    const mid = (this.pinch.mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    this.camera.set(s, mid.x - c.x * s, mid.y - c.y * s);
  }

  #pinchEnd() {
    const { mid } = this.pinch;
    this.pinch = null;
    this.ptr = null; // the finger left on screen starts nothing new
    const cam = this.camera;
    const s = Math.max(1, Math.min(MAX_ZOOM, cam.s));
    if (s !== cam.s) {
      const c = cam.toContent(mid.x, mid.y);
      cam.animateTo(s, mid.x - c.x * s, mid.y - c.y * s, 220);
    }
  }

  #wheel(e) {
    e.preventDefault();
    const cam = this.camera;
    const p = this.#local(e);
    if (e.ctrlKey) {
      cam.stop();
      return cam.zoomAround(p.x, p.y, Math.max(1, Math.min(MAX_ZOOM, cam.s * Math.exp(-e.deltaY * 0.01))));
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
      return this.#lookupWord(ptr.cx0, ptr.cy0);
    }
    this.lastTap = { t: now, x: ptr.cx0, y: ptr.cy0 };
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => {
      this.lastTap = null;
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
    const rects = rangeRects(spans, word.a, word.b);
    if (!rects.length) return;
    this.#drawHighlights(rects, 'word');
    const anchor = this.lock.rectToLocal(rects[0]);
    const target = this.settings.translateTo;
    this.popWord = { text: word.text, lang: guessLang(word.text) };
    this.#renderPopup(anchor, { word: word.text, loading: true });
    try {
      let res = await translate(word.text, target);
      // Word already in the target language → show English instead.
      if (res.source && res.source.split('-')[0] === target.split('-')[0] && target !== 'en') {
        res = await translate(word.text, 'en');
      }
      if (this.popWord?.text !== word.text) return;
      if (res.source) this.popWord.lang = res.source === 'he' ? 'iw' : res.source;
      this.#renderPopup(anchor, { word: word.text, result: res });
    } catch {
      if (this.popWord?.text === word.text) this.#renderPopup(anchor, { word: word.text, error: true });
    }
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
    pop.innerHTML = `
      <div class="pop-main">
        <button class="pop-word" data-act="popSpeak" aria-label="Pronounce ${esc(word)}">${icons.speaker}<span>${esc(word)}</span></button>
        <div class="pop-tr" dir="${rtl ? 'rtl' : 'auto'}">${loading ? '<span class="dots"><i></i><i></i><i></i></span>' : error ? '<span class="muted">No connection</span>' : tl}</div>
      </div>
      ${alts}
      <div class="pop-foot">
        <button class="pop-copy" data-act="popCopy" aria-label="Copy word">${icons.copy}</button>
        <span class="pop-credit">translated by <b>Google</b></span>
      </div>`;
    pop.hidden = false;
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

  #closePopup() {
    if (this.pop.hidden) return;
    this.pop.hidden = true;
    this.popWord = null;
    this.hlLayer.querySelectorAll('.hl.word').forEach((h) => h.remove());
  }

  // ------------------------------------------------------------------ read-aloud selection

  #enterReadMode() {
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
    bar.querySelector('.tts-label').textContent = state === 'loading' ? 'Preparing…' : state === 'paused' ? 'Paused' : 'Reading aloud';
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
    this.el.remove();
    this.doc.destroy();
  }
}
