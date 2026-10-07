// Thin wrapper around PDF.js: open documents, render pages to canvases,
// build text layers, and import new books into the library.
//
// Two engines: PDF.js 6 for current browsers, PDF.js 2.16 for older ones
// (iOS 12 / Safari 12 cannot run PDF.js 6). Each is loaded only when needed.
import { addBook } from './db.js';
import { applyTone } from './tone.js';

/** PDF.js 6 needs roughly Safari 16.4+; regex lookbehind arrived in the same release. */
function supportsModernEngine() {
  try {
    new RegExp('(?<=a)b');
    return typeof structuredClone === 'function' && typeof Array.prototype.findLast === 'function';
  } catch (e) {
    return false;
  }
}

let enginePromise;
export function pdfEngine() {
  if (!enginePromise) {
    enginePromise = (supportsModernEngine() ? import('./pdfEngineModern.js') : Promise.reject(new Error('old browser'))).catch(
      () => import('./pdfEngineLegacy.js'),
    );
  }
  return enginePromise;
}

export async function openPdf(data) {
  return (await pdfEngine()).open(data);
}

// Canvas memory is the main constraint on tablets and phones. iOS Safari is
// strict: past a total canvas-memory limit it silently refuses new canvases,
// so Apple devices get a smaller budget.
export const IS_IOS = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MAX_PIXELS = IS_IOS ? 4_500_000 : 7_000_000;
/** Budget for the sharp re-render of an on-screen page while zoomed in. */
export const ZOOM_PIXELS = IS_IOS ? 9_000_000 : 16_000_000;

/** Free a canvas's pixel memory right away (iOS doesn't do it promptly on its own). */
export function releaseCanvas(c) {
  if (c) c.width = c.height = 0;
}

/** Render a page so that it is `cssWidth` CSS pixels wide. */
export async function renderPageCanvas(page, cssWidth, { maxDpr = 2.5, maxPixels = MAX_PIXELS, tone = 'original' } = {}) {
  const base = page.getViewport({ scale: 1 });
  let dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  let scale = (cssWidth / base.width) * dpr;
  if (base.width * base.height * scale * scale > maxPixels) {
    scale = Math.sqrt(maxPixels / (base.width * base.height));
  }
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport, background: '#fff' });
  await task.promise;
  if (tone !== 'original') await applyTone(canvas, page, viewport, tone);
  return canvas;
}

/** Build a selectable/hit-testable text layer sized to `cssWidth`. */
export async function buildTextLayer(page, container, cssWidth) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: cssWidth / base.width });
  return (await pdfEngine()).textLayer(page, container, viewport);
}

const toBlob = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));

function cleanName(fileName) {
  return fileName
    .replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function hashId(file) {
  // Name + size + a slice of the content identifies a file well enough to skip duplicates.
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const meta = new TextEncoder().encode(`${file.name}|${file.size}|`);
  const buf = new Uint8Array(meta.length + head.length);
  buf.set(meta);
  buf.set(head, meta.length);
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // crypto.subtle only exists on HTTPS/localhost; on a plain-http LAN address use two FNV-1a passes.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const b of buf) {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ b, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export const isSupportedFile = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';

/** Import one PDF file into the library. Returns the stored book record. */
export async function importFile(file, existingIds = new Set()) {
  const id = await hashId(file);
  if (existingIds.has(id)) return null;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await openPdf(data.slice());
  try {
    let title = '';
    let author = '';
    try {
      const { info } = await doc.getMetadata();
      title = (info?.Title || '').trim();
      author = (info?.Author || '').trim();
    } catch {}
    // Metadata titles are often junk like "Microsoft Word - draft3.docx".
    if (!title || /\.(docx?|indd|pdf)$|^untitled/i.test(title)) title = cleanName(file.name);
    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    const cover = await renderPageCanvas(first, 420, { maxDpr: 1 });
    const coverBlob = await toBlob(cover, 'image/jpeg', 0.85);
    const book = {
      id,
      title,
      author,
      fileName: file.name,
      size: file.size,
      pageCount: doc.numPages,
      aspect: vp.width / vp.height,
      cover: coverBlob,
      addedAt: Date.now(),
      lastOpenedAt: 0,
      lastPage: 1,
      finished: false,
    };
    await addBook(book, new Blob([data], { type: 'application/pdf' }));
    return book;
  } finally {
    doc.destroy();
  }
}
