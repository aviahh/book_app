// Renders pages once at the current display size and hands out cheap copies,
// so the same page can appear in a slot and on a turning leaf at the same time.
// Rendering is serialized; visible pages jump the queue ahead of prefetches.
import { renderPageCanvas, releaseCanvas, IS_IOS } from '../pdf.js';

export class PageCache {
  constructor(doc, limit = IS_IOS ? 8 : 14) {
    this.doc = doc;
    this.limit = limit;
    this.width = 0;
    this.map = new Map(); // page -> { promise, resolve, reject, prio, width }
    this.pending = [];
    this.busy = false;
    this.pages = new Map();
  }

  page(n) {
    if (!this.pages.has(n)) this.pages.set(n, this.doc.getPage(n));
    return this.pages.get(n);
  }

  /** Page tone (original / warm / night): changing it re-renders everything. */
  setTone(tone) {
    if (tone === this.tone) return;
    this.tone = tone;
    for (const e of this.map.values()) e.promise.then(releaseCanvas, () => {});
    this.map.clear();
    this.pending = [];
  }

  /** Render width in CSS px; zoomed reading uses bigger renders and a smaller cache. */
  setWidth(width, { limit = this.limit, maxPixels } = {}) {
    width = Math.round(width);
    this.limit = limit;
    this.maxPixels = maxPixels;
    if (width === this.width) return;
    this.width = width;
    this.map.clear();
    this.pending = [];
  }

  /** Promise of the master canvas for page n. prio 0 = visible now. */
  get(n, prio = 0) {
    let entry = this.map.get(n);
    if (entry) {
      this.map.delete(n);
      this.map.set(n, entry); // LRU bump
      if (prio < entry.prio) entry.prio = prio;
      return entry.promise;
    }
    entry = { n, prio, width: this.width };
    entry.promise = new Promise((res, rej) => Object.assign(entry, { resolve: res, reject: rej }));
    entry.promise.catch(() => {});
    this.map.set(n, entry);
    this.pending.push(entry);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      const old = this.map.get(oldest);
      this.map.delete(oldest);
      this.pending = this.pending.filter((e) => e !== old);
      old.promise.then(releaseCanvas, () => {});
    }
    this.#pump();
    return entry.promise;
  }

  /** Lower all queued priorities so a new navigation target renders first. */
  demoteAll() {
    for (const e of this.pending) e.prio = Math.max(e.prio, 2);
  }

  async #pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.pending.length) {
      this.pending.sort((a, b) => a.prio - b.prio);
      const e = this.pending.shift();
      try {
        e.resolve(await renderPageCanvas(await this.page(e.n), e.width, { tone: this.tone || 'original', ...(this.maxPixels ? { maxPixels: this.maxPixels } : {}) }));
      } catch (err) {
        e.reject(err);
        if (this.map.get(e.n) === e) this.map.delete(e.n);
      }
    }
    this.busy = false;
  }

  /** Fill `target` canvas with page n (copy of the cached master). */
  async paint(n, target, prio = 0) {
    let src = await this.get(n, prio);
    if (!src.width) src = await this.get(n, prio); // evicted and freed meanwhile: render again
    target.width = src.width;
    target.height = src.height;
    target.getContext('2d').drawImage(src, 0, 0);
    target.classList.add('ready');
  }
}
