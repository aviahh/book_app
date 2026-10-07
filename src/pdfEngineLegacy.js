// PDF engine for older browsers (e.g. iOS 12 / Safari 12): PDF.js 2.16, the
// last line built for them. Loaded as a classic script from public/pdfjs-legacy
// (copied there by scripts/copy-pdfjs-assets.mjs) so the bundler leaves it as is.

const BASE = new URL('pdfjs-legacy/', document.baseURI).href;
let lib;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

async function pdfjs() {
  if (!lib) {
    // PDF.js 6 also sets window.pdfjsLib; only reuse it if it is really 2.x.
    const existing = window.pdfjsLib;
    if (!existing || !String(existing.version || '').startsWith('2.')) await loadScript(BASE + 'pdf.min.js');
    lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.js';
  }
  return lib;
}

export const name = 'pdf.js 2.16 (legacy)';

export async function open(data) {
  const p = await pdfjs();
  return p.getDocument({
    data,
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
  }).promise;
}

export async function textLayer(page, container, viewport) {
  const p = await pdfjs();
  const textContent = await page.getTextContent();
  const task = p.renderTextLayer({ textContent, container, viewport, textDivs: [] });
  await task.promise;
  return task;
}
