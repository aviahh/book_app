// Reading tools that open in a side panel — search, bookmarks, contents —
// and the floating tools bubble: a small, see-through button the reader can
// drag anywhere; a tap fans out their favorite tools, "More" shows the rest,
// and a press and hold (or "Edit") picks and orders the favorites.
//
// The reader hands over a small bridge (`api`) instead of its internals.

import { icons } from '../icons.js';
import { updateBook } from '../db.js';
import { getSettings, setSetting } from '../settings.js';

export const TOOLS = {
  search: { label: 'Search', icon: 'search' },
  bookmark: { label: 'Bookmark page', icon: 'bookmark' },
  bookmarks: { label: 'Bookmarks', icon: 'bookmarks' },
  stopmark: { label: 'Mark where I stopped', icon: 'flag' },
  resume: { label: 'Where I stopped', icon: 'flagGo' },
  readAloud: { label: 'Read aloud', icon: 'speaker' },
  contents: { label: 'Contents', icon: 'contents' },
  thumbs: { label: 'Page overview', icon: 'thumbs' },
  goto: { label: 'Go to page', icon: 'hash' },
  tone: { label: 'Page tone', icon: 'tone' },
  lock: { label: 'Lock rotation', icon: 'lock' },
  fullscreen: { label: 'Full screen', icon: 'expand' },
  settings: { label: 'Settings', icon: 'settings' },
};
export const DEFAULT_FAVORITES = ['search', 'bookmark', 'stopmark', 'bookmarks', 'readAloud', 'contents'];
const DOCK_MIN = 900; // screens at least this wide keep Search open beside the book
const DOCK_W = 380;

const FAB_KEY = 'folio.fab.v1';
const TONES = ['original', 'warm', 'night'];
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fold = (s) => s.toLowerCase();

/** Plain text of a page from the PDF itself (for search and bookmark snippets). */
async function plainText(doc, n) {
  const page = await doc.getPage(n);
  const tc = await page.getTextContent();
  let s = '';
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    s += it.str;
    if (it.hasEOL) s += '\n';
  }
  return s
    .replace(/([A-Za-z])-\n(?=[a-z])/g, '$1') // hyphenated across lines
    .replace(/\s+/g, ' ')
    .trim();
}

export class ReaderTools {
  constructor(api) {
    this.api = api;
    this.el = api.el;
    this.texts = []; // page texts, filled in as search needs them
    this.query = '';
    this.#buildPanel();
    this.#buildFab();
  }

  // ------------------------------------------------------------------ side panel

  #buildPanel() {
    const p = (this.panel = document.createElement('aside'));
    p.className = 'tool-panel';
    p.hidden = true;
    p.innerHTML = `
      <header class="tp-head"><h2></h2><button class="tp-close" aria-label="Close">${icons.close}</button></header>
      <div class="tp-body"></div>`;
    (this.api.root || this.el).append(p);
    p.querySelector('.tp-close').addEventListener('click', () => this.closePanel());
    // Phones: Search shrinks to a small bar after picking a result.
    const bar = (this.findBar = document.createElement('div'));
    bar.className = 'find-bar';
    bar.hidden = true;
    bar.innerHTML = `
      <button data-f="prev" aria-label="Previous match">${icons.chevronLeft}</button>
      <span class="fb-count"></span>
      <button data-f="next" aria-label="Next match">${icons.chevronRight}</button>
      <span class="fb-q" dir="auto"></span>
      <button data-f="list" aria-label="Show all matches">${icons.contents}</button>
      <button data-f="close" aria-label="Close search">${icons.close}</button>`;
    this.el.append(bar);
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    bar.addEventListener('click', (e) => {
      const f = e.target.closest('[data-f]');
      if (!f) return;
      const k = f.dataset.f;
      if (k === 'prev' || k === 'next') this.#step(k === 'next' ? 1 : -1);
      else if (k === 'list') this.openSearch();
      else this.closeSearch();
    });
    // Keep touches in the panel away from the page underneath.
    for (const t of ['pointerdown', 'wheel', 'touchstart']) p.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
  }

  #openPanel(kind, title) {
    if (this.panelKind === 'search' && kind !== 'search') this.#undock();
    this.findBar.hidden = true;
    this.panelKind = kind;
    this.panel.dataset.kind = kind;
    this.panel.querySelector('h2').textContent = title;
    this.panel.hidden = false;
    this.closeFabMenu();
    const body = this.panel.querySelector('.tp-body');
    body.onclick = body.onpointerdown = null; // handlers of the previous panel
    return body;
  }

  closePanel() {
    const wasSearch = this.panelKind === 'search';
    if (wasSearch) this.searchToken = (this.searchToken || 0) + 1;
    this.panel.hidden = true;
    this.panelKind = null;
    this.#undock();
    if (wasSearch && this.findBar.hidden) this.api.searchClosed();
  }

  /** Search is open: its panel, or (phones) its small bar. */
  get searchActive() {
    return this.panelKind === 'search' || !this.findBar.hidden;
  }

  /** Search closed for good (from the small bar). */
  closeSearch() {
    this.findBar.hidden = true;
    if (this.panelKind === 'search') this.closePanel();
    else this.api.searchClosed();
  }

  #undock() {
    if (this.docked) {
      this.docked = false;
      this.panel.classList.remove('docked');
      this.api.dock(0);
    }
  }

  /** The panel would hide part of the page jumped to: close it. */
  #afterJump() {
    this.closePanel();
  }

  // ---- search

  openSearch() {
    const body = this.#openPanel('search', 'Search');
    // Wide screens: the book makes room and the results stay beside it.
    if (window.innerWidth >= DOCK_MIN && !this.docked) {
      this.docked = true;
      this.panel.classList.add('docked');
      this.api.dock(DOCK_W);
    }
    body.innerHTML = `
      <label class="tp-search">${icons.search}<input type="search" enterkeyhint="search" placeholder="Words or a phrase" aria-label="Search this book" value="${esc(this.query)}"></label>
      <p class="tp-status" aria-live="polite"></p>
      <ol class="tp-results"></ol>`;
    const input = body.querySelector('input');
    let t;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => this.#search(input.value), 250);
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (clearTimeout(t), this.#search(input.value), input.blur()));
    body.querySelector('.tp-results').addEventListener('click', (e) => {
      const li = e.target.closest('[data-k]');
      if (li) this.#show(+li.dataset.k);
    });
    if (this.query) this.#search(this.query);
    else setTimeout(() => input.focus(), 60);
  }

  async #search(q) {
    q = q.trim();
    const keep = q === this.query ? this.current : -1; // reopened: stay on the match being read
    this.query = q;
    const token = (this.searchToken = (this.searchToken || 0) + 1);
    this.results = [];
    this.current = keep;
    const body = this.panel.querySelector('.tp-body');
    const list = body.querySelector('.tp-results');
    const status = body.querySelector('.tp-status');
    list.innerHTML = '';
    if (q.length < 2) {
      status.textContent = q ? 'Type at least two letters' : '';
      return;
    }
    const needle = fold(q);
    const total = this.api.total;
    let found = 0;
    const MAX = 300;
    for (let n = 1; n <= total && found < MAX; n++) {
      if (token !== this.searchToken) return;
      if (this.texts[n] == null) {
        try {
          this.texts[n] = await plainText(this.api.doc, n);
        } catch (e) {
          this.texts[n] = '';
        }
        if (n % 20 === 0) status.textContent = `Searching… page ${n} of ${total}`;
      }
      const text = this.texts[n];
      const hay = fold(text);
      let at = hay.indexOf(needle);
      let nth = 0;
      const items = [];
      while (at >= 0 && nth < 20) {
        const a = Math.max(0, at - 50);
        const b = Math.min(text.length, at + q.length + 70);
        const before = (a > 0 ? '…' : '') + text.slice(a, at);
        const after = text.slice(at + q.length, b) + (b < text.length ? '…' : '');
        this.results.push({ page: n, nth });
        items.push(`<li data-k="${this.results.length - 1}"><span class="tp-page">p. ${n}</span><span class="tp-snip" dir="auto">${esc(before)}<mark>${esc(text.slice(at, at + q.length))}</mark>${esc(after)}</span></li>`);
        nth++;
        found++;
        at = hay.indexOf(needle, at + needle.length);
      }
      if (items.length) {
        list.insertAdjacentHTML('beforeend', items.join(''));
        const here = this.current >= 0 && list.querySelector(`li[data-k="${this.current}"]:not(.current)`);
        if (here) {
          here.classList.add('current');
          here.scrollIntoView({ block: 'center' });
        }
      }
    }
    if (token !== this.searchToken) return;
    status.textContent = found
      ? `${found >= MAX ? `${MAX}+` : found} match${found === 1 ? '' : 'es'}`
      : this.texts.slice(1).every((t) => !t)
        ? 'This book has no searchable text (scanned pages)'
        : `No matches for “${q}”`;
  }

  /** Open match k: its page, the match marked. The results stay open (or shrink to the bar on phones). */
  #show(k) {
    const res = this.results && this.results[k];
    if (!res) return;
    this.current = k;
    this.api.goToPage(res.page, { find: this.query, nth: res.nth });
    for (const li of this.panel.querySelectorAll('.tp-results li.current')) li.classList.remove('current');
    const li = this.panel.querySelector(`.tp-results li[data-k="${k}"]`);
    if (li) li.classList.add('current');
    if (!this.docked) {
      this.panel.hidden = true;
      this.panelKind = null;
      this.findBar.hidden = false;
    }
    this.findBar.querySelector('.fb-count').textContent = `${k + 1} / ${this.results.length}`;
    this.findBar.querySelector('.fb-q').textContent = this.query;
  }

  #step(d) {
    if (!this.results || !this.results.length) return;
    this.#show((this.current + d + this.results.length) % this.results.length);
  }

  // ---- bookmarks

  get bookmarks() {
    return this.api.book.bookmarks || [];
  }

  isBookmarked(n) {
    return this.bookmarks.some((b) => b.page === n);
  }

  async toggleBookmark() {
    const n = this.api.currentPage();
    const had = this.isBookmarked(n);
    const list = had ? this.bookmarks.filter((b) => b.page !== n) : [...this.bookmarks, { page: n, at: Date.now() }].sort((a, b) => a.page - b.page);
    await this.#saveBookmarks(list);
    if (had) this.api.toast(`Bookmark removed · page ${n}`);
    else this.#noteEditor(n, true);
  }

  /** A short note on a bookmark: why this page. */
  #noteEditor(page, fresh) {
    const b = this.bookmarks.find((x) => x.page === page);
    if (!b) return;
    const body = this.#openPanel('note', fresh ? `Bookmarked page ${page}` : `Bookmark · page ${page}`);
    body.innerHTML = `
      <label class="tp-note"><span>Why this page? (optional)</span><textarea rows="3" maxlength="200" dir="auto" placeholder="e.g. First time we meet Rem">${esc(b.note || '')}</textarea></label>
      <div class="tp-actions"><button class="tp-btn quiet" data-n="skip">${fresh ? 'Skip' : 'Cancel'}</button><button class="tp-btn" data-n="save">Save</button></div>`;
    const ta = body.querySelector('textarea');
    setTimeout(() => ta.focus(), 80);
    body.onclick = async (e) => {
      const act = e.target.closest('[data-n]');
      if (!act) return;
      body.onclick = null;
      if (act.dataset.n === 'save') {
        const note = ta.value.trim();
        await this.#saveBookmarks(this.bookmarks.map((x) => (x.page === page ? { ...x, note } : x)));
      }
      if (fresh) this.closePanel();
      else this.openBookmarks();
    };
  }

  async #saveBookmarks(list) {
    this.api.book.bookmarks = list;
    await updateBook(this.api.book.id, { bookmarks: list });
    this.decorateAll();
    if (this.panelKind === 'bookmarks') this.openBookmarks();
    this.#renderFabMenu();
  }

  decorateAll() {
    for (const p of this.el.querySelectorAll('.page[data-page]')) this.decoratePage(p, +p.dataset.page);
  }

  /**
   * Marks on a page: a red ribbon for a bookmark, a gold ribbon for the
   * reading position (it slides in when it moves to a new page), and a small
   * flag in the margin at the line where you stopped.
   */
  decoratePage(pageEl, n) {
    pageEl.classList.toggle('bookmarked', this.isBookmarked(n));
    const m = this.api.stopMark();
    let flag = pageEl.querySelector('.stop-flag');
    if (m && m.page === n) {
      if (!flag) {
        flag = document.createElement('span');
        flag.className = 'stop-flag';
        flag.innerHTML = icons.flag;
        pageEl.append(flag);
      }
      flag.style.top = `${m.fy * 100}%`;
      flag.classList.toggle('no-line', !m.line);
    } else if (flag) flag.remove();
  }

  openBookmarks() {
    const body = this.#openPanel('bookmarks', 'Bookmarks');
    const list = this.bookmarks;
    const pos = this.api.readingPos();
    const stop = this.api.stopMark();
    const day = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const snip = (n) => esc(this.texts[n] ? this.texts[n].slice(0, 110) : '…');
    body.innerHTML = `
      <ol class="tp-results marks">
        <li class="mk pos" data-go="pos"><span class="mk-ico">${icons.bookmark}</span><span class="mk-text"><b>Reading position</b><span class="mk-sub">Page ${pos} · follows you as you read</span></span></li>
        <li class="mk stop" data-go="${stop ? 'stop' : 'place'}"><span class="mk-ico">${icons.flag}</span><span class="mk-text"><b>Where I stopped</b><span class="mk-sub" dir="auto">${
          stop ? `Page ${stop.page}${stop.line ? ` · “${esc(stop.line.slice(0, 70))}${stop.line.length > 70 ? '…' : ''}”` : ' · spot only, no line recorded'}` : 'Not marked yet — tap to mark a line'
        }</span></span>${stop ? `<button class="tp-del mk-edit" data-mk="restop" aria-label="Mark a new spot">${icons.edit}</button><button class="tp-del" data-mk="unstop" aria-label="Remove where I stopped">${icons.close}</button>` : ''}</li>
      </ol>
      <h3 class="ed-h">Bookmarks</h3>
      ${
        list.length
          ? `<ol class="tp-results bookmarks">${list
              .map(
                (b) => `<li data-page="${b.page}"><span class="tp-page">p. ${b.page}</span>${b.note ? `<span class="tp-note-text" dir="auto">${esc(b.note)}</span>` : ''}<span class="tp-snip" dir="auto">${snip(b.page)}</span><span class="tp-date">${day(b.at)} · <button class="tp-link" data-note="${b.page}">${b.note ? 'Edit note' : 'Add a note'}</button></span><button class="tp-del" data-del="${b.page}" aria-label="Remove bookmark on page ${b.page}">${icons.close}</button></li>`,
              )
              .join('')}</ol>`
          : `<p class="tp-hint">No bookmarks yet. Use <b>Bookmark page</b> in the tools bubble to mark the page you're on.</p>`
      }`;
    body.querySelector('.marks').addEventListener('click', (e) => {
      const li = e.target.closest('[data-go]');
      if (e.target.closest('[data-mk="unstop"]')) return this.api.clearStopMark().then(() => this.openBookmarks());
      if (e.target.closest('[data-mk="restop"]') || (li && li.dataset.go === 'place')) {
        this.closePanel();
        return this.api.placeStopMark();
      }
      if (!li) return;
      this.closePanel();
      if (li.dataset.go === 'pos') this.api.goToPage(pos);
      else this.api.goToStop();
    });
    // Fill in the first words of each page.
    list.forEach(async (b) => {
      if (this.texts[b.page] == null) {
        try {
          this.texts[b.page] = await plainText(this.api.doc, b.page);
        } catch (e) {
          this.texts[b.page] = '';
        }
      }
      const snip = body.querySelector(`li[data-page="${b.page}"] .tp-snip`);
      if (snip) snip.textContent = this.texts[b.page].slice(0, 110) || 'No text on this page';
    });
    const bl = body.querySelector('ol.bookmarks');
    if (bl) bl.addEventListener('click', (e) => {
      const note = e.target.closest('[data-note]');
      if (note) return this.#noteEditor(+note.dataset.note, false);
      const del = e.target.closest('[data-del]');
      if (del) return this.#saveBookmarks(this.bookmarks.filter((b) => b.page !== +del.dataset.del));
      const li = e.target.closest('[data-page]');
      if (!li) return;
      this.api.goToPage(+li.dataset.page);
      this.#afterJump();
    });
  }

  // ---- contents

  async openContents() {
    const body = this.#openPanel('contents', 'Contents');
    body.innerHTML = '<p class="tp-status">Loading…</p>';
    const items = await this.api.outline();
    if (this.panelKind !== 'contents') return;
    if (!items.length) {
      body.innerHTML = `<div class="tp-empty">${icons.contents}<p>This book has no table of contents.</p><p class="muted">Search can still find a chapter by its title.</p></div>`;
      return;
    }
    const cur = this.api.currentPage();
    let here = -1;
    items.forEach((it, i) => it.page && it.page <= cur && (here = i));
    body.innerHTML = `<ol class="tp-toc">${items
      .map((it, i) => `<li data-page="${it.page || ''}" class="${i === here ? 'here' : ''}${it.page ? '' : ' dim'}" style="--depth:${Math.min(it.depth, 4)}"><span dir="auto">${esc(it.title)}</span>${it.page ? `<span class="tp-page">${it.page}</span>` : ''}</li>`)
      .join('')}</ol>`;
    const hereEl = body.querySelector('.here');
    if (hereEl) hereEl.scrollIntoView({ block: 'center' });
    body.querySelector('ol').addEventListener('click', (e) => {
      const li = e.target.closest('[data-page]');
      if (!li || !li.dataset.page) return;
      this.api.goToPage(+li.dataset.page);
      this.#afterJump();
    });
  }

  // ------------------------------------------------------------------ tools

  #label(id) {
    if (id === 'bookmark') return this.isBookmarked(this.api.currentPage()) ? 'Remove bookmark' : 'Bookmark page';
    if (id === 'readAloud') return this.api.isReading() ? 'Stop read aloud' : 'Read aloud';
    if (id === 'tone') return `Page tone: ${getSettings().pageTone}`;
    return TOOLS[id].label;
  }

  run(id) {
    this.closeFabMenu();
    switch (id) {
      case 'search':
        return this.openSearch();
      case 'bookmark':
        return this.toggleBookmark();
      case 'bookmarks':
        return this.openBookmarks();
      case 'stopmark':
        this.closePanel();
        return this.api.placeStopMark();
      case 'resume':
        this.closePanel();
        return this.api.goToStop();
      case 'contents':
        return this.openContents();
      case 'tone': {
        const t = getSettings().pageTone;
        const next = TONES[(TONES.indexOf(t) + 1) % TONES.length];
        setSetting('pageTone', next);
        return this.api.toast(`Page tone: ${next}`);
      }
      default:
        return this.api.toolbar(id === 'readAloud' ? 'speak' : id);
    }
  }

  // ------------------------------------------------------------------ the bubble

  get favorites() {
    const f = getSettings().fabTools;
    return (Array.isArray(f) ? f : DEFAULT_FAVORITES).filter((id) => TOOLS[id]);
  }

  #buildFab() {
    const fab = (this.fab = document.createElement('button'));
    fab.className = 'fab';
    fab.setAttribute('aria-label', 'Tools');
    fab.setAttribute('aria-haspopup', 'menu');
    fab.innerHTML = icons.wand;
    const menu = (this.fabMenu = document.createElement('div'));
    menu.className = 'fab-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    this.el.append(menu, fab);
    this.#placeFab();
    this.sync();

    let press = null;
    fab.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        fab.setPointerCapture(e.pointerId);
      } catch (err) {}
      const r = fab.getBoundingClientRect();
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, held: false };
      fab.classList.add('touched');
      press.timer = setTimeout(() => {
        if (!press || press.moved) return;
        press.held = true;
        if (navigator.vibrate) navigator.vibrate(10);
        this.openEditor();
      }, 550);
    });
    fab.addEventListener('pointermove', (e) => {
      if (!press || e.pointerId !== press.id) return;
      if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 8) return;
      press.moved = true;
      clearTimeout(press.timer);
      this.closeFabMenu();
      fab.classList.add('dragging');
      this.#moveFab(e.clientX - press.dx, e.clientY - press.dy);
    });
    const up = (e) => {
      if (!press || e.pointerId !== press.id) return;
      clearTimeout(press.timer);
      fab.classList.remove('touched', 'dragging');
      if (press.moved) this.#saveFab();
      else if (!press.held && e.type === 'pointerup') this.fabMenu.hidden ? this.openFabMenu() : this.closeFabMenu();
      press = null;
    };
    fab.addEventListener('pointerup', up);
    fab.addEventListener('pointercancel', up);
    fab.addEventListener('click', (e) => e.stopPropagation());
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tool]');
      if (!b) return;
      const id = b.dataset.tool;
      if (id === '_more') return this.#renderFabMenu(true);
      if (id === '_edit') return this.openEditor();
      this.run(id);
    });
    // A touch anywhere else closes the menu.
    this.outside = (e) => {
      if (!this.fabMenu.hidden && !this.fabMenu.contains(e.target) && !this.fab.contains(e.target)) this.closeFabMenu();
    };
    document.addEventListener('pointerdown', this.outside, true);
    // A panel closes with a plain tap on the page: one finger, still, quick,
    // and not the first half of a double tap. Pinching, dragging, double-tap
    // zoom, turning pages and the reader's own controls leave it open.
    const CONTROLS = '.chrome, .edge-arrow, .tts-bar, .pos-ribbon, .zoom-chip, .place-hint, .return-pill, .word-pop, .toast';
    this.outsidePanel = (e) => {
      const tap = this.outsideTap;
      if (tap) {
        tap.multi = true; // a second finger (pinch), or a second tap (double tap)
        clearTimeout(tap.timer);
      }
      if (this.panel.hidden || this.panelKind === 'note' || this.panelKind === 'editor') return (this.outsideTap = null);
      const t = e.target;
      if (this.panel.contains(t) || this.fab.contains(t) || this.fabMenu.contains(t) || this.findBar.contains(t) || (t.closest && t.closest(CONTROLS))) return (this.outsideTap = null);
      if (tap && performance.now() - tap.t < 400) return; // second tap of a double tap: zooming
      this.outsideTap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), multi: false };
    };
    this.outsideUp = (e) => {
      const tap = this.outsideTap;
      if (!tap || tap.done || e.pointerId !== tap.id) return;
      tap.done = true;
      if (tap.multi || performance.now() - tap.t > 400 || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) return (this.outsideTap = null);
      // Wait out a possible second tap before closing.
      tap.timer = setTimeout(() => {
        if (this.outsideTap === tap && !tap.multi) {
          this.outsideTap = null;
          this.closePanel();
        }
      }, 320);
    };
    document.addEventListener('pointerdown', this.outsidePanel, true);
    document.addEventListener('pointerup', this.outsideUp, true);
  }

  /** Show or hide the bubble (Settings). */
  sync() {
    const on = getSettings().fab !== false;
    this.fab.hidden = !on;
    if (!on) this.closeFabMenu();
  }

  #placeFab() {
    let pos = null;
    try {
      pos = JSON.parse(localStorage.getItem(FAB_KEY) || 'null');
    } catch (e) {}
    this.fabPos = pos && typeof pos.x === 'number' ? pos : { x: 1, y: 0.62 }; // right edge, a little below the middle
    this.layout();
  }

  /** Re-place after the screen changes size (kept as fractions of the screen). */
  layout() {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (!W || !H) return;
    const s = 52;
    const m = 10;
    const x = m + (W - s - 2 * m) * this.fabPos.x;
    const y = m + (H - s - 2 * m) * this.fabPos.y;
    this.fab.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.fabXY = { x, y };
    if (!this.fabMenu.hidden) this.#placeMenu();
  }

  #moveFab(x, y) {
    const box = this.el.getBoundingClientRect();
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    const s = 52;
    const m = 10;
    this.fabPos = {
      x: Math.max(0, Math.min(1, (x - box.left - m) / (W - s - 2 * m))),
      y: Math.max(0, Math.min(1, (y - box.top - m) / (H - s - 2 * m))),
    };
    this.layout();
  }

  #saveFab() {
    // Snap to the nearer side, like a floating button should.
    this.fabPos.x = this.fabPos.x < 0.5 ? 0 : 1;
    this.fab.classList.add('snapping');
    this.layout();
    setTimeout(() => this.fab.classList.remove('snapping'), 260);
    try {
      localStorage.setItem(FAB_KEY, JSON.stringify(this.fabPos));
    } catch (e) {}
  }

  openFabMenu() {
    this.#renderFabMenu(false);
    this.fabMenu.hidden = false;
    this.fab.classList.add('open');
  }

  closeFabMenu() {
    if (!this.fabMenu || this.fabMenu.hidden) return;
    this.fabMenu.hidden = true;
    this.fab.classList.remove('open');
  }

  #renderFabMenu(all = this.fabMenu.dataset.all === '1') {
    if (this.fabMenu.hidden && !all) {
      /* rendered when opened */
    }
    const fav = this.favorites;
    const ids = all ? Object.keys(TOOLS).filter((id) => !fav.includes(id)) : fav;
    this.fabMenu.dataset.all = all ? '1' : '';
    const item = (id) => `<button role="menuitem" data-tool="${id}"><span class="fm-ico">${icons[TOOLS[id].icon]}</span><span class="fm-label">${esc(this.#label(id))}</span></button>`;
    this.fabMenu.innerHTML =
      ids.map(item).join('') +
      (all
        ? `<button role="menuitem" data-tool="_edit" class="fm-quiet"><span class="fm-ico">${icons.edit}</span><span class="fm-label">Edit favorites</span></button>`
        : `<button role="menuitem" data-tool="_more" class="fm-quiet"><span class="fm-ico">${icons.more}</span><span class="fm-label">More</span></button>`);
    this.#placeMenu();
  }

  /** Beside the bubble, on the side with room, kept on screen. */
  #placeMenu() {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    const { x, y } = this.fabXY;
    const menu = this.fabMenu;
    const wasHidden = menu.hidden;
    menu.style.visibility = 'hidden';
    menu.hidden = false;
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.hidden = wasHidden;
    menu.style.visibility = '';
    const right = x + 26 < W / 2; // bubble on the left → menu to its right
    const left = right ? x + 62 : x - 10 - mw;
    const top = Math.max(10, Math.min(H - mh - 10, y + 26 - mh / 2));
    menu.style.left = `${Math.max(10, left)}px`;
    menu.style.top = `${top}px`;
    menu.classList.toggle('from-left', right);
  }

  // ---- choosing favorites

  openEditor() {
    this.closeFabMenu();
    const body = this.#openPanel('editor', 'Tools bubble');
    const draw = () => {
      const fav = this.favorites;
      const rest = Object.keys(TOOLS).filter((id) => !fav.includes(id));
      const row = (id, inFav) =>
        `<li data-id="${id}">${inFav ? `<span class="ed-grip" aria-hidden="true">${icons.grip}</span>` : ''}<span class="fm-ico">${icons[TOOLS[id].icon]}</span><span class="ed-label">${esc(TOOLS[id].label)}</span><button class="ed-btn ${inFav ? 'rm' : 'add'}" data-${inFav ? 'rm' : 'add'}="${id}" aria-label="${inFav ? 'Remove' : 'Add'} ${esc(TOOLS[id].label)}">${inFav ? icons.minus : icons.plus}</button></li>`;
      body.innerHTML = `
        <p class="tp-hint">Tap the bubble to open these. Drag <span class="ed-grip-inline">${icons.grip}</span> to change the order. Drag the bubble itself anywhere on the screen.</p>
        <h3 class="ed-h">Favorites</h3>
        <ol class="ed-list fav">${fav.map((id) => row(id, true)).join('') || '<li class="ed-none">None — everything is under More</li>'}</ol>
        <h3 class="ed-h">More tools</h3>
        <ol class="ed-list">${rest.map((id) => row(id, false)).join('') || '<li class="ed-none">All tools are favorites</li>'}</ol>
        <button class="ed-reset">Reset to the usual tools</button>`;
    };
    draw();
    const save = (list) => {
      setSetting('fabTools', list);
      draw();
    };
    body.onclick = (e) => {
      const add = e.target.closest('[data-add]');
      const rm = e.target.closest('[data-rm]');
      if (add) save([...this.favorites, add.dataset.add]);
      else if (rm) save(this.favorites.filter((id) => id !== rm.dataset.rm));
      else if (e.target.closest('.ed-reset')) save(DEFAULT_FAVORITES.slice());
    };
    // Reorder by dragging the grip.
    body.onpointerdown = (e) => {
      const grip = e.target.closest('.ed-grip');
      if (!grip) return;
      e.preventDefault();
      const li = grip.closest('li');
      const list = li.parentElement;
      li.classList.add('lifting');
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (err) {}
      const y0 = e.clientY;
      const move = (ev) => {
        li.style.transform = `translateY(${ev.clientY - y0}px)`;
        const siblings = [...list.children].filter((x) => x !== li && x.dataset.id);
        const mid = ev.clientY;
        let before = null;
        for (const s of siblings) {
          const r = s.getBoundingClientRect();
          if (mid < r.top + r.height / 2) {
            before = s;
            break;
          }
        }
        li.dataset.before = before ? before.dataset.id : '';
      };
      const end = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', end);
        grip.removeEventListener('pointercancel', end);
        const ids = this.favorites.filter((id) => id !== li.dataset.id);
        const b = li.dataset.before;
        if (b === undefined) return draw();
        const at = b ? ids.indexOf(b) : ids.length;
        ids.splice(at < 0 ? ids.length : at, 0, li.dataset.id);
        save(ids);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    };
  }

  destroy() {
    document.removeEventListener('pointerdown', this.outside, true);
    document.removeEventListener('pointerdown', this.outsidePanel, true);
    document.removeEventListener('pointerup', this.outsideUp, true);
  }
}
