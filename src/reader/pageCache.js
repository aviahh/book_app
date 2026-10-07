// Renders pages once at the current display size and hands out cheap copies,
// so the same page can appear in a slot and on a turning leaf at the same time.
// Rendering is serialized; visible pages jump the queue ahead of prefetches.
import { renderPageCanvas, releaseCanvas, canvasOk, IS_IOS, LOW_MEMORY, CanvasMemoryError } from '../pdf.js';

export class PageCache {
  constructor(doc, limit = LOW_MEMORY ? 5 : IS_IOS ? 8 : 14) {
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
    this.#clear();
  }

  /** Free every cached page image (iOS only frees canvas memory when told to). */
  #clear() {
    for (const e of this.map.values()) e.promise.then(releaseCanvas, () => {});
    this.map.clear();
    this.pending = [];
  }

  /** Free least-recently-used pages until at most `keep` remain. */
  #trim(keep) {
    for (const [n, old] of [...this.map]) {
      if (this.map.size <= keep) break;
      if (old === this.rendering) continue; // the page being drawn right now stays
      this.map.delete(n);
      this.pending = this.pending.filter((e) => e !== old);
      old.promise.then(releaseCanvas, () => {});
    }
  }

  /** Out of canvas memory: keep only the most recent few pages. */
  relieve() {
    this.#trim(Math.min(2, this.map.size));
  }

  destroy() {
    this.#clear();
    this.destroyed = true;
  }

  /** Render width in CSS px; zoomed reading uses bigger renders and a smaller cache. */
  setWidth(width, { limit = this.limit, maxPixels } = {}) {
    width = Math.round(width);
    this.limit = limit;
    this.maxPixels = maxPixels;
    if (width === this.width) return;
    this.width = width;
    this.#clear();
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
    this.#trim(this.limit);
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
      this.rendering = e;
      const render = async () => renderPageCanvas(await this.page(e.n), e.width, { tone: this.tone || 'original', ...(this.maxPixels ? { maxPixels: this.maxPixels } : {}) });
      try {
        let canvas;
        try {
          canvas = await render();
        } catch (err) {
          if (!(err instanceof CanvasMemoryError)) throw err;
          // Make room and try once more, after the browser has had a moment to reclaim it.
          this.relieve();
          await new Promise((r) => setTimeout(r, 60));
          canvas = await render();
        }
        e.resolve(canvas); // if it was evicted meanwhile, the eviction frees it
      } catch (err) {
        e.reject(err);
        if (this.map.get(e.n) === e) this.map.delete(e.n);
      }
    }
    this.rendering = null;
    this.busy = false;
  }

  /** Fill `target` canvas with page n (copy of the cached master). */
  async paint(n, target, prio = 0) {
    for (let attempt = 0; ; attempt++) {
      let src = await this.get(n, prio);
      if (!src.width) src = await this.get(n, prio); // evicted and freed meanwhile: render again
      target.width = src.width;
      target.height = src.height;
      const ctx = target.getContext('2d');
      if (ctx) ctx.drawImage(src, 0, 0);
      if (canvasOk(target)) break;
      // Out of canvas memory: free older pages and try once more.
      releaseCanvas(target);
      if (attempt) throw new CanvasMemoryError();
      this.relieve();
      await new Promise((r) => setTimeout(r, 80));
    }
    target.classList.add('ready');
  }
}
