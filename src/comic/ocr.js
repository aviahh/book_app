// Text recognition in comics and manga: press and hold a speech bubble and
// its words are read from the picture, on this device (Tesseract, loaded the
// first time it's needed; the pictures never leave the device).
//
// Finding the bubble: from the pressed point, the light area around it is
// filled outwards (a bubble is a light shape with a dark outline). Its extent
// is the bubble, letters and all. Only that area is read, the rest of the
// picture masked out, enlarged so the letters are a good size to recognise.
// When there's no closed bubble (narration on a light background), a
// window around the point is read instead.

const BASE = new URL('ocr/', document.baseURI).href;
const LANGS = { en: 'eng', ja: 'jpn', 'ja-v': 'jpn_vert' };

let engine = null; // { worker, lang }
let busy = Promise.resolve();

async function workerFor(lang) {
  const code = LANGS[lang] || 'eng';
  if (engine && engine.code === code) return engine.worker;
  if (engine) {
    await engine.worker.terminate().catch(() => {});
    engine = null;
  }
  const mod = await import('tesseract.js/dist/tesseract.esm.min.js');
  const { createWorker, OEM } = mod.createWorker ? mod : mod.default;
  const worker = await createWorker(code, OEM.LSTM_ONLY, {
    workerPath: BASE + 'worker.min.js',
    corePath: BASE + 'core/',
    langPath: BASE + 'lang/',
    workerBlobURL: false, // the worker runs from Folio's own address
    gzip: true,
  });
  engine = { worker, code };
  return worker;
}

/** Let go of the engine (its memory), e.g. when the comic is closed. */
export async function closeOcr() {
  const e = engine;
  engine = null;
  if (e) await e.worker.terminate().catch(() => {});
}

// ---------------------------------------------------------------- the bubble

const LIGHT = 200;

/**
 * The bubble around (x, y) in a grey picture w×h: { x0, y0, x1, y1, rows } with,
 * per row, the span from its first to its last bubble pixel; null if there's
 * no bubble-like shape there.
 */
export function findBubble(gray, w, h, x, y) {
  x = Math.max(0, Math.min(w - 1, Math.round(x)));
  y = Math.max(0, Math.min(h - 1, Math.round(y)));
  // Pressed on a letter: the nearest light pixel is inside the bubble.
  let seed = -1;
  for (let r = 0; r <= 24 && seed < 0; r++) {
    for (let dy = -r; dy <= r && seed < 0; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && gray[yy * w + xx] >= LIGHT) {
          seed = yy * w + xx;
          break;
        }
      }
    }
  }
  if (seed < 0) return null;
  const seen = new Uint8Array(w * h);
  const stack = [seed];
  seen[seed] = 1;
  const max = w * h * 0.3;
  let n = 0;
  let x0 = w;
  let y0 = h;
  let x1 = 0;
  let y1 = 0;
  const rowMin = new Int32Array(h).fill(w);
  const rowMax = new Int32Array(h).fill(-1);
  while (stack.length) {
    const i = stack.pop();
    const px = i % w;
    const py = (i - px) / w;
    if (++n > max) return null; // not a closed shape: the light page itself
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
    if (px < rowMin[py]) rowMin[py] = px;
    if (px > rowMax[py]) rowMax[py] = px;
    if (px > 0 && !seen[i - 1] && gray[i - 1] >= LIGHT) (seen[i - 1] = 1), stack.push(i - 1);
    if (px < w - 1 && !seen[i + 1] && gray[i + 1] >= LIGHT) (seen[i + 1] = 1), stack.push(i + 1);
    if (py > 0 && !seen[i - w] && gray[i - w] >= LIGHT) (seen[i - w] = 1), stack.push(i - w);
    if (py < h - 1 && !seen[i + w] && gray[i + w] >= LIGHT) (seen[i + w] = 1), stack.push(i + w);
  }
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  // Too small to hold words (the gap inside a letter, a highlight in the art).
  if (n < w * h * 0.0015 || bw < w * 0.04 || bh < h * 0.02) return null;
  const rows = [];
  for (let r = y0; r <= y1; r++) rows.push(rowMax[r] >= 0 ? [rowMin[r], rowMax[r]] : null);
  return { x0, y0, x1, y1, rows };
}

/**
 * No closed bubble (words on a light background, a caption): the block of
 * dark marks around (x, y), grown outwards while more marks lie close by.
 */
export function textBlock(gray, w, h, x, y) {
  const m = Math.max(4, Math.round(Math.max(w, h) * 0.022)); // about a letter's gap
  let x0 = Math.max(0, x - m);
  let x1 = Math.min(w - 1, x + m);
  let y0 = Math.max(0, y - m);
  let y1 = Math.min(h - 1, y + m);
  const dark = (ax, bx, ay, by) => {
    for (let yy = Math.max(0, ay); yy <= Math.min(h - 1, by); yy++) {
      for (let xx = Math.max(0, ax); xx <= Math.min(w - 1, bx); xx++) if (gray[yy * w + xx] < 120) return true;
    }
    return false;
  };
  if (!dark(x0, x1, y0, y1)) return null;
  for (let i = 0; i < 80; i++) {
    let grew = false;
    if (x0 > 0 && dark(x0 - m, x0 - 1, y0, y1)) (x0 = Math.max(0, x0 - m)), (grew = true);
    if (x1 < w - 1 && dark(x1 + 1, x1 + m, y0, y1)) (x1 = Math.min(w - 1, x1 + m)), (grew = true);
    if (y0 > 0 && dark(x0, x1, y0 - m, y0 - 1)) (y0 = Math.max(0, y0 - m)), (grew = true);
    if (y1 < h - 1 && dark(x0, x1, y1 + 1, y1 + m)) (y1 = Math.min(h - 1, y1 + m)), (grew = true);
    if (!grew || x1 - x0 > w * 0.75 || y1 - y0 > h * 0.4) break; // the art itself, not words
  }
  return { x0, y0, x1, y1 };
}

/** Grey values of an image region, at most `max` pixels on its longer side. */
function grayOf(img, sx, sy, sw, sh, max = 900) {
  const k = Math.min(1, max / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k));
  const h = Math.max(1, Math.round(sh * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000;
  c.width = c.height = 0;
  return { g, w, h, k };
}

/**
 * Read the words at (ix, iy) of a picture (pixels of `img`, within the area
 * sx..sx+sw it shows). lang: 'en' | 'ja' | 'ja-v'.
 * Returns { text, box: { x, y, w, h } (picture pixels), bubble: whether a bubble was found }.
 */
export function readAt(img, { sx = 0, sw = img.naturalWidth || img.width, ix, iy, lang = 'en' }) {
  const job = busy.then(() => read(img, sx, sw, ix, iy, lang));
  busy = job.catch(() => {});
  return job;
}

async function read(img, sx, sw, ix, iy, lang) {
  const ih = img.naturalHeight || img.height;
  const a = grayOf(img, sx, 0, sw, ih);
  const b = findBubble(a.g, a.w, a.h, (ix - sx) * a.k, iy * a.k);
  let box;
  let rows = null;
  if (b) {
    box = { x: sx + b.x0 / a.k, y: b.y0 / a.k, w: (b.x1 - b.x0 + 1) / a.k, h: (b.y1 - b.y0 + 1) / a.k };
    rows = b;
  } else {
    // No closed bubble: the words around the point, or else a window around it.
    const t = textBlock(a.g, a.w, a.h, Math.round((ix - sx) * a.k), Math.round(iy * a.k));
    if (t && t.x1 - t.x0 <= a.w * 0.75 && t.y1 - t.y0 <= a.h * 0.4) {
      const pad = 6;
      box = { x: sx + Math.max(0, t.x0 - pad) / a.k, y: Math.max(0, t.y0 - pad) / a.k, w: (t.x1 - t.x0 + 2 * pad) / a.k, h: (t.y1 - t.y0 + 2 * pad) / a.k };
    } else {
      const w = sw * 0.4;
      const h = ih * 0.18;
      box = { x: Math.max(sx, Math.min(sx + sw - w, ix - w / 2)), y: Math.max(0, Math.min(ih - h, iy - h / 2)), w, h };
    }
  }
  // The bubble, enlarged so letters are around 40 px tall, everything outside it white.
  const scale = Math.max(1, Math.min(4, 1100 / Math.max(box.w, box.h)));
  const cw = Math.round(box.w * scale) + 40;
  const ch = Math.round(box.h * scale) + 40;
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, box.x, box.y, box.w, box.h, 20, 20, box.w * scale, box.h * scale);
  const d = ctx.getImageData(0, 0, cw, ch);
  const px = d.data;
  const f = scale / a.k; // analysis pixels → canvas pixels
  for (let y = 0; y < ch; y++) {
    let lo = -1;
    let hi = 1e9;
    if (rows) {
      const r = rows.rows[Math.floor((y - 20) / f)];
      lo = r ? 20 + (r[0] - rows.x0 + 0.5) * f : 1e9;
      hi = r ? 20 + (r[1] - rows.x0 + 0.5) * f : -1;
    }
    for (let x = 0; x < cw; x++) {
      const j = (y * cw + x) * 4;
      // Grey, with the contrast of print: letters black, paper white.
      let v = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
      v = v < 110 ? 0 : v > 190 ? 255 : ((v - 110) / 80) * 255;
      if (rows && (x < lo || x > hi || y < 20 || y >= ch - 20)) v = 255;
      px[j] = px[j + 1] = px[j + 2] = v;
      px[j + 3] = 255;
    }
  }
  ctx.putImageData(d, 0, 0);
  const worker = await workerFor(lang);
  await worker.setParameters({ tessedit_pageseg_mode: lang === 'ja-v' ? '5' : '6', preserve_interword_spaces: '1' });
  const { data } = await worker.recognize(c);
  c.width = c.height = 0;
  return { text: tidy(data.text || '', lang), box, bubble: !!b, confidence: data.confidence || 0 };
}

/** Lines of a bubble as one passage; comic capitals in ordinary case (better to translate and to hear). */
export function tidy(raw, lang) {
  if (lang !== 'en') return raw.replace(/\s+/g, '').trim();
  let t = raw
    .replace(/[|]/g, 'I')
    .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2') // a word broken over two lines
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .trim();
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length > 3 && letters === letters.toUpperCase()) {
    t = t.toLowerCase().replace(/(^|[.!?…]\s+|["“(]\s*)([a-z])/g, (m, p, c) => p + c.toUpperCase());
    t = t.replace(/\bi\b/g, 'I').replace(/\bi'(m|ll|ve|d)\b/g, (m, x) => `I'${x}`);
  }
  return t;
}
