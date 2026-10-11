// EPUB books in the library: importing them, and setting their pages for
// reading with the reader's text settings. Loaded only when an EPUB is used.
import { Epub } from './epub.js';
import { layoutBook, layoutKey, pageBox, textSize, FONTS } from './layout.js';
import { EpubDoc } from './doc.js';
import { getSettings } from '../settings.js';
import { addBook } from '../db.js';

/** The text settings pages are set with on this device. */
export function textOptions(s = getSettings()) {
  const { W, H } = pageBox();
  return { W, H, font: FONTS[s.epubFont] ? s.epubFont : 'literata', size: textSize(W, s.epubSize || 100), spacing: s.epubSpacing || 'normal' };
}

// The last book typeset, kept so reopening it (or changing its text size) is quick.
let cached = null;

async function typeset(id, bytes, opts, onProgress) {
  if (!cached || cached.id !== id) cached = { id, epub: new Epub(bytes), layouts: new Map() };
  const key = layoutKey(opts);
  let layout = cached.layouts.get(key);
  if (!layout) {
    layout = await layoutBook(cached.epub, opts, onProgress);
    cached.layouts.clear(); // one layout at a time: they can be large
    cached.layouts.set(key, layout);
  }
  return { epub: cached.epub, layout };
}

const startsOf = (layout) => {
  const out = [];
  for (const p of layout.pages) out.push(p.ch, p.o);
  return out;
};

/** The page (1-based) of `layout` that holds chapter position (ch, o). */
function pageFor(layout, ch, o) {
  const pages = layout.pages;
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const p = pages[mid];
    if (p.ch < ch || (p.ch === ch && p.o <= o)) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Pages are set differently (other text size, font or screen): move every
 * saved page number of the book to the page now holding the same text.
 * Returns the fields that changed.
 */
function remap(book, layout) {
  const old = book.epub && book.epub.starts;
  const patch = { epub: { key: layout.key, starts: startsOf(layout) }, pageCount: layout.pages.length, aspect: layout.W / layout.H };
  if (!old || !old.length) return patch;
  const map = (n) => {
    if (!n) return n;
    const i = Math.min(Math.max(1, n), old.length / 2) - 1;
    return pageFor(layout, old[2 * i], old[2 * i + 1]);
  };
  patch.lastPage = map(book.lastPage || 1);
  if (book.readingPos) patch.readingPos = map(book.readingPos);
  if (Array.isArray(book.bookmarks) && book.bookmarks.length) {
    const seen = new Set();
    patch.bookmarks = book.bookmarks
      .map((b) => Object.assign({}, b, { page: map(b.page) }))
      .filter((b) => (seen.has(b.page) ? false : seen.add(b.page)));
  }
  if (book.stopMark) patch.stopMark = Object.assign({}, book.stopMark, { page: map(book.stopMark.page) });
  return patch;
}

/**
 * Open a stored EPUB for reading: typeset it for this device and the
 * current text settings, and bring its saved positions along if the pages
 * changed. Updates `book` in place. Returns a document for the reader.
 */
export async function openEpubBook(book, blob, onProgress, save) {
  const bytes = new Uint8Array(await new Response(blob).arrayBuffer());
  const opts = textOptions();
  const { epub, layout } = await typeset(book.id, bytes, opts, onProgress);
  if (!book.epub || book.epub.key !== layout.key || book.pageCount !== layout.pages.length) {
    const patch = remap(book, layout);
    Object.assign(book, patch);
    await save(patch);
    return { doc: new EpubDoc(epub, layout), moved: true };
  }
  return { doc: new EpubDoc(epub, layout), moved: false };
}

// ------------------------------------------------------------------ import

const loadImage = (blob) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => (URL.revokeObjectURL(url), reject(new Error('bad image')));
    img.src = url;
  });
const toBlob = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));

/** A small JPEG of the book's cover picture, or a plain typeset cover when it has none. */
async function makeCover(epub, title, author, aspect) {
  const W = 420;
  const H = Math.round(W / aspect);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (epub.coverPath) {
    try {
      const { img, url } = await loadImage(epub.blob(epub.coverPath));
      canvas.width = W;
      canvas.height = Math.round((W * img.naturalHeight) / img.naturalWidth);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      return await toBlob(canvas, 'image/jpeg', 0.85);
    } catch (e) {}
  }
  canvas.width = W;
  canvas.height = H;
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hues = [18, 205, 150, 340, 40, 260];
  const hue = hues[h % hues.length];
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `hsl(${hue},32%,30%)`);
  g.addColorStop(1, `hsl(${hue},36%,18%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(232,205,160,0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(22, 22, W - 44, H - 44);
  ctx.fillStyle = '#efe3cc';
  ctx.textAlign = 'center';
  const family = FONTS.literata.family;
  // Title, wrapped to fit
  let size = 40;
  const words = title.split(/\s+/);
  let lines;
  for (;;) {
    ctx.font = `600 ${size}px ${family}`;
    lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > W - 90 && line) lines.push(line), (line = w);
      else line = t;
    }
    lines.push(line);
    if (lines.length <= 5 || size <= 22) break;
    size -= 4;
  }
  let y = H * 0.38 - ((lines.length - 1) * size * 1.2) / 2;
  for (const l of lines) ctx.fillText(l, W / 2, y), (y += size * 1.2);
  if (author) {
    ctx.font = `italic 400 22px ${family}`;
    ctx.fillStyle = 'rgba(239,227,204,0.8)';
    ctx.fillText(author, W / 2, H * 0.8);
  }
  return toBlob(canvas, 'image/jpeg', 0.88);
}

const cleanName = (n) => n.replace(/\.epub$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Import one EPUB file. Returns the stored book record. */
export async function importEpub(file, id, extra) {
  const bytes = new Uint8Array(await new Response(file).arrayBuffer());
  const opts = textOptions();
  const { epub, layout } = await typeset(id, bytes, opts);
  const title = epub.title || cleanName(file.name);
  const author = epub.author || '';
  let cover = null;
  try {
    cover = await makeCover(epub, title, author, layout.W / layout.H);
  } catch (e) {}
  const book = Object.assign(
    {
      id,
      format: 'epub',
      title,
      author,
      fileName: file.name,
      size: file.size,
      pageCount: layout.pages.length,
      aspect: layout.W / layout.H,
      cover,
      addedAt: Date.now(),
      lastOpenedAt: 0,
      lastPage: 1,
      finished: false,
      epub: { key: layout.key, starts: startsOf(layout) },
    },
    extra || {},
  );
  await addBook(book, new Blob([bytes], { type: 'application/epub+zip' }));
  return book;
}
