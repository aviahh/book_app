// PDF engine for current browsers: PDF.js 6 (its "legacy" build, which
// supports Safari 16.4+, Chrome 110+, Firefox ESR).
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const ASSETS = new URL('pdfjs/', document.baseURI).href;

export const name = 'pdf.js 6';

export async function open(data) {
  const task = pdfjs.getDocument({
    data,
    cMapUrl: ASSETS + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: ASSETS + 'standard_fonts/',
    wasmUrl: ASSETS + 'wasm/',
  });
  const doc = await task.promise;
  // PDF.js 6 moved teardown to the loading task.
  if (!doc.destroy) doc.destroy = () => task.destroy();
  return doc;
}

export async function textLayer(page, container, viewport) {
  container.style.setProperty('--total-scale-factor', viewport.scale);
  container.style.setProperty('--scale-round-x', '1px');
  container.style.setProperty('--scale-round-y', '1px');
  const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
  await layer.render();
  return layer;
}
