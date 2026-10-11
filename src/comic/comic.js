// Comics and manga: CBZ (zip) and CBR (rar) archives of page pictures.
//
// The pictures become pages of a PDF.js-like document, so the reader turns,
// zooms and bookmarks them like any book. Two extras:
//   - right-to-left (manga): pages are drawn mirrored and the reader mirrors
//     its whole page area back, so turning, swiping and zooming all run the
//     other way without the reader having to know;
//   - two-page artwork (one wide picture) is cut into its two halves, so in
//     the two-page view it spreads across both pages, as printed.
// "Vertical scroll" (webtoons) shows the pictures one under another, each
// at its own height.
import { unzipSync } from 'fflate';
import { imageSize } from '../epub/epub.js';
import { addBook } from '../db.js';

const IMAGE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };
const typeOf = (name) => TYPES[(name.split('.').pop() || '').toLowerCase()] || 'image/jpeg';

/** "page 2" before "page 10". */
const collator = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
const natural = (a, b) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0);

const isZip = (b) => b[0] === 0x50 && b[1] === 0x4b;
const isRar = (b) => b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21;

/** The archive's files: { name → bytes }. */
async function unpack(bytes) {
  if (isZip(bytes)) return unzipSync(bytes, { filter: (f) => IMAGE.test(f.name) || /comicinfo\.xml$/i.test(f.name) });
  if (isRar(bytes)) {
    const [{ createExtractorFromData }, { default: wasmUrl }] = await Promise.all([import('node-unrar-js'), import('node-unrar-js/esm/js/unrar.wasm?url')]);
    const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
    const extractor = await createExtractorFromData({ wasmBinary, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    const out = {};
    const { files } = extractor.extract({ files: (h) => !h.flags.directory && (IMAGE.test(h.name) || /comicinfo\.xml$/i.test(h.name)) });
    for (const f of files) if (f.extraction) out[f.fileHeader.name] = f.extraction; // (read to the end: frees the archive)
    return out;
  }
  throw new Error('Not a comic archive');
}

/** ComicInfo.xml (from ComicRack and most comic tools): title, series, number, manga direction. */
function comicInfo(files) {
  const name = Object.keys(files).find((k) => /(^|\/)comicinfo\.xml$/i.test(k));
  if (!name) return {};
  try {
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(files[name]), 'application/xml');
    const get = (tag) => {
      const el = doc.getElementsByTagName(tag)[0];
      return el ? el.textContent.trim() : '';
    };
    return { title: get('Title'), series: get('Series'), number: get('Number'), volume: get('Volume'), writer: get('Writer'), manga: get('Manga') };
  } catch (e) {
    return {};
  }
}

export class Comic {
  static async open(bytes) {
    const c = new Comic();
    c.files = await unpack(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    c.info = comicInfo(c.files);
    c.images = Object.keys(c.files)
      .filter((k) => IMAGE.test(k) && !/(^|\/)(__MACOSX|\.)/.test(k))
      .sort(natural)
      .map((name) => {
        const d = imageSize(c.files[name]) || { w: 1000, h: 1500 };
        return { name, w: d.w || 1000, h: d.h || 1500 };
      });
    if (!c.images.length) throw new Error('No pages in this comic');
    // The usual page shape: the middle value of the upright pages.
    const shapes = c.images.map((i) => i.w / i.h).filter((a) => a < 1).sort((a, b) => a - b);
    c.aspect = shapes.length ? shapes[Math.floor(shapes.length / 2)] : c.images[0].w / c.images[0].h;
    c.rtl = /righttoleft/i.test(c.info.manga || '');
    // Long strips (webtoons) read best scrolling down.
    c.tall = c.aspect < 0.52;
    return c;
  }

  blob(name) {
    return new Blob([this.files[name]], { type: typeOf(name) });
  }
}

/**
 * The pages: each picture once, except wide two-page artwork, which is cut
 * into halves when its left half lands on a left-hand page of the spread
 * (else it stays whole on one page). Page 1 is the cover, alone.
 */
export function comicPages(comic, { rtl, view }) {
  const pages = [];
  for (const img of comic.images) {
    const wide = img.w / img.h > Math.max(1, comic.aspect * 1.55);
    const n = pages.length + 1;
    if (wide && view !== 'scroll' && n % 2 === 0) {
      // Read first: the left half (or the right half, right to left).
      pages.push({ img, half: rtl ? 1 : 0 }, { img, half: rtl ? 0 : 1 });
    } else pages.push({ img, half: -1 });
  }
  return pages;
}

const PAPER = { original: '#ffffff', warm: '#f6ead3', night: '#1d1b18' };

export class ComicDoc {
  constructor(comic, opts) {
    this.comic = comic;
    this.rtl = !!opts.rtl;
    this.view = opts.view;
    this.pages = comicPages(comic, opts);
    this.numPages = this.pages.length;
    this.images = new Map();
    this.pageObjs = new Map();
    this.fixedImages = true;
    // Base page size: 1000 wide, the usual page shape.
    this.W = 1000;
    this.H = Math.round(1000 / comic.aspect);
  }

  getPage(n) {
    if (!this.pageObjs.has(n)) this.pageObjs.set(n, new ComicPage(this, n));
    return Promise.resolve(this.pageObjs.get(n));
  }

  /** Height of page n for a page `w` wide (pictures of their own shape in vertical scroll). */
  heightOf(n, w) {
    const p = this.pages[n - 1];
    return this.view === 'scroll' ? (w * p.img.h) / p.img.w : (w * this.H) / this.W;
  }

  async getOutline() {
    // Folders in the archive (chapters, volumes) make a table of contents.
    const out = [];
    let last = null;
    this.pages.forEach((p, i) => {
      const dir = p.img.name.includes('/') ? p.img.name.slice(0, p.img.name.lastIndexOf('/')) : '';
      if (dir !== last) {
        last = dir;
        if (dir) out.push({ title: dir.split('/').pop().replace(/[_]+/g, ' '), dest: [i], items: [] });
      }
    });
    return out.length >= 2 ? out : [];
  }

  async getDestination(d) {
    return d;
  }

  async getPageIndex(ref) {
    return typeof ref === 'number' ? ref : -1;
  }

  async getMetadata() {
    return { info: { Title: this.comic.info.title || '', Author: this.comic.info.writer || '' } };
  }

  image(name) {
    let e = this.images.get(name);
    if (e) {
      this.images.delete(name);
      this.images.set(name, e);
      return e.promise;
    }
    const url = URL.createObjectURL(this.comic.blob(name));
    e = {
      url,
      promise: new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      }),
    };
    this.images.set(name, e);
    // Big pictures take a lot of memory once decoded: keep only a few.
    for (const [k, old] of this.images) {
      if (this.images.size <= 6) break;
      this.images.delete(k);
      URL.revokeObjectURL(old.url);
    }
    return e.promise;
  }

  destroy() {
    for (const e of this.images.values()) URL.revokeObjectURL(e.url);
    this.images.clear();
  }
}

class ComicPage {
  constructor(doc, n) {
    this.doc = doc;
    this.n = n;
    this.p = doc.pages[n - 1];
    this.selfToned = true;
  }

  getViewport({ scale = 1 } = {}) {
    const W = this.doc.W;
    const H = this.doc.heightOf(this.n, W);
    return { width: W * scale, height: H * scale, scale, convertToViewportPoint: (x, y) => [x * scale, y * scale] };
  }

  render({ canvasContext: ctx, viewport, tone = 'original' }) {
    return { promise: this.#draw(ctx, viewport, tone) };
  }

  async #draw(ctx, vp, tone) {
    const img = await this.doc.image(this.p.img.name);
    const W = vp.width;
    const H = vp.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PAPER[tone] || PAPER.original;
    ctx.fillRect(0, 0, W, H);
    if (!img) return;
    // Right to left: drawn mirrored; the reader mirrors the page area back.
    if (this.doc.rtl) ctx.setTransform(-1, 0, 0, 1, W, 0);
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    let sx = 0;
    let sw = iw;
    if (this.p.half >= 0) {
      sw = iw / 2;
      sx = this.p.half ? iw / 2 : 0;
    }
    // Fit the picture in the page (the usual shape fills it; others get a margin).
    const k = Math.min(W / sw, H / ih);
    const dw = sw * k;
    const dh = ih * k;
    // A half of a spread sits against the spine.
    const dx = this.p.half === 0 ? W - dw : this.p.half === 1 ? 0 : (W - dw) / 2;
    const dy = (H - dh) / 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, 0, sw, ih, dx, dy, dw, dh);
    if (tone === 'night') {
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(dx, dy, dw, dh);
    } else if (tone === 'warm') {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = '#f6ead3';
      ctx.fillRect(dx, dy, dw, dh);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  async getTextContent() {
    return { items: [], styles: {} };
  }

  async getAnnotations() {
    return [];
  }

  buildTextLayer() {
    return Promise.resolve();
  }
}

// ------------------------------------------------------------------ library

let cached = null;

/** Open a stored comic for reading with its reading settings. */
export async function openComicBook(book, blob) {
  if (!cached || cached.id !== book.id) {
    const bytes = new Uint8Array(await new Response(blob).arrayBuffer());
    cached = { id: book.id, comic: await Comic.open(bytes) };
  }
  return new ComicDoc(cached.comic, comicOptions(book, cached.comic));
}

/** The book's reading direction and view (its own choice, else what the file suggests). */
export function comicOptions(book, comic) {
  const c = book.comic || {};
  return { rtl: c.rtl != null ? c.rtl : comic.rtl, view: c.view || (comic.tall ? 'scroll' : 'pages') };
}

const cleanName = (n) => n.replace(/\.(cbz|cbr|zip|rar)$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
const toBlob = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));

export async function importComic(file, id, extra) {
  const bytes = new Uint8Array(await new Response(file).arrayBuffer());
  const comic = await Comic.open(bytes);
  cached = { id, comic };
  const info = comic.info;
  let title = info.title || '';
  if (info.series) title = `${info.series}${info.volume || info.number ? `, Vol. ${info.volume || info.number}` : ''}${info.title && info.title !== info.series ? ` — ${info.title}` : ''}`;
  if (!title) title = cleanName(file.name);
  // Cover: the first picture, small.
  let cover = null;
  try {
    const doc = new ComicDoc(comic, { rtl: false, view: 'pages' });
    const img = await doc.image(comic.images[0].name);
    const canvas = document.createElement('canvas');
    canvas.width = 420;
    canvas.height = Math.round((420 * img.naturalHeight) / img.naturalWidth);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    cover = await toBlob(canvas, 'image/jpeg', 0.85);
    doc.destroy();
  } catch (e) {}
  const opts = comicOptions({}, comic);
  const pages = comicPages(comic, opts);
  const book = Object.assign(
    {
      id,
      format: 'comic',
      title,
      author: info.writer || '',
      fileName: file.name,
      size: file.size,
      pageCount: pages.length,
      aspect: comic.aspect,
      cover,
      addedAt: Date.now(),
      lastOpenedAt: 0,
      lastPage: 1,
      finished: false,
      comic: { rtl: opts.rtl, view: opts.view },
    },
    extra || {},
  );
  await addBook(book, new Blob([bytes], { type: isRar(bytes) ? 'application/vnd.comicbook-rar' : 'application/vnd.comicbook+zip' }));
  return book;
}
