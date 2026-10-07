// Thumbnail strip: a horizontally scrolling row of small spreads/pages,
// rendered lazily as they scroll into view.
import { icons } from '../icons.js';
import { PageCache } from './pageCache.js';
import { spreadCount, spreadPages, visiblePages } from './spreads.js';

export class ThumbStrip {
  constructor(el, doc, api) {
    this.el = el;
    this.doc = doc;
    this.api = api;
    this.open = false;
    this.cache = new PageCache(doc, 60);
    this.cache.setWidth(64);
    el.innerHTML = `
      <button class="ts-nav prev" aria-label="Scroll thumbnails left">${icons.chevronLeft}</button>
      <div class="ts-track" role="list"></div>
      <button class="ts-nav next" aria-label="Scroll thumbnails right">${icons.chevronRight}</button>
      <div class="ts-label"></div>`;
    this.track = el.querySelector('.ts-track');
    this.io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) this.#paint(en.target);
    }, { root: this.track, rootMargin: '0px 400px' });
    el.querySelector('.ts-nav.prev').addEventListener('click', (e) => (e.stopPropagation(), this.#scrollBy(-1)));
    el.querySelector('.ts-nav.next').addEventListener('click', (e) => (e.stopPropagation(), this.#scrollBy(1)));
    this.track.addEventListener('click', (e) => {
      const item = e.target.closest('.ts-item');
      if (item) this.api.go(+item.dataset.index);
    });
  }

  rebuild() {
    this.built = false;
    if (this.open) this.#build();
  }

  #build() {
    this.io.disconnect();
    const mode = this.api.mode();
    const total = this.doc.numPages;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < spreadCount(mode, total); i++) {
      const item = document.createElement('button');
      item.className = 'ts-item';
      item.dataset.index = i;
      item.setAttribute('role', 'listitem');
      const pages = visiblePages(spreadPages(mode, i, total));
      item.setAttribute('aria-label', `Page${pages.length > 1 ? 's' : ''} ${pages.join('–')}`);
      for (const p of pages) {
        const c = document.createElement('canvas');
        c.dataset.page = p;
        item.append(c);
      }
      frag.append(item);
      this.io.observe(item);
    }
    this.track.replaceChildren(frag);
    this.built = true;
  }

  #paint(item) {
    if (item.dataset.painted) return;
    item.dataset.painted = '1';
    for (const c of item.querySelectorAll('canvas')) this.cache.paint(+c.dataset.page, c, 1).catch(() => {});
  }

  #scrollBy(dir) {
    this.track.scrollBy({ left: dir * this.track.clientWidth * 0.8, behavior: 'smooth' });
  }

  sync(scroll = false) {
    this.el.querySelector('.ts-label').textContent = `${this.api.label()} / ${this.doc.numPages}`;
    if (!this.built) return;
    const cur = this.api.current();
    for (const it of this.track.querySelectorAll('.ts-item.current')) it.classList.remove('current');
    const item = this.track.children[cur];
    if (item) {
      item.classList.add('current');
      if (scroll) item.scrollIntoView({ inline: 'center', block: 'nearest' });
    }
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    this.open = true;
    this.el.hidden = false;
    if (!this.built) this.#build();
    this.sync(true);
  }

  close() {
    this.open = false;
    this.el.hidden = true;
    this.el.closest('.reader')?.querySelector('[data-act="thumbs"]')?.classList.remove('on');
  }

  destroy() {
    this.io.disconnect();
    this.cache.destroy();
  }
}
