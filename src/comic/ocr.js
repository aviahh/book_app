// Text recognition in comics and manga, on this device (Tesseract, loaded the
// first time it's needed; the pictures never leave the device).
//
// Finding a bubble: a bubble is a light shape with a dark outline. From a
// pressed point the light area around it is filled outwards; for a whole page
// every such area is found, and those that hold dark marks (letters) are the
// bubbles and caption boxes. Only the inside of a bubble is read: the outline
// is left out (it would read as stray "I"s and "|"s), the letters are
// enlarged to the size the engine reads best, and the picture is turned into
// clean black and white.
//
// Each bubble comes back as lines of words with their positions, so the
// reader can lay an invisible text layer over the picture: words can then be
// selected, translated and read aloud like the text of any book. A page's
// bubbles are put in reading order (rows from the top; right to left in manga).

const BASE = new URL('ocr/', document.baseURI).href;
const LANGS = { en: 'eng', ja: 'jpn', 'ja-v': 'jpn_vert' };

let engine = null; // { worker, code }
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

/** One recognition at a time (one engine). */
function queued(fn) {
  const job = busy.then(fn);
  busy = job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------- finding bubbles

const LIGHT = 200;
const DARK = 120;

/** Grey values of an image region, at most `max` pixels on its longer side. */
function grayOf(img, sx, sy, sw, sh, max = 1000) {
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
 * The light area containing pixel `seed`: its extent and, per row, the span
 * from its first to its last pixel (letters inside it are holes, still
 * inside the span). null when it grows past `max` pixels (the page itself).
 */
function fillFrom(gray, w, h, seed, seen, max) {
  const stack = [seed];
  seen[seed] = 1;
  let n = 0;
  let x0 = w;
  let y0 = h;
  let x1 = 0;
  let y1 = 0;
  const rowMin = new Map();
  const rowMax = new Map();
  let over = false;
  while (stack.length) {
    const i = stack.pop();
    const px = i % w;
    const py = (i - px) / w;
    if (++n > max) over = true; // keep filling (so it's all marked seen), but it's no bubble
    if (!over) {
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      if (!(rowMin.get(py) <= px)) rowMin.set(py, px);
      if (!(rowMax.get(py) >= px)) rowMax.set(py, px);
    }
    if (px > 0 && !seen[i - 1] && gray[i - 1] >= LIGHT) (seen[i - 1] = 1), stack.push(i - 1);
    if (px < w - 1 && !seen[i + 1] && gray[i + 1] >= LIGHT) (seen[i + 1] = 1), stack.push(i + 1);
    if (py > 0 && !seen[i - w] && gray[i - w] >= LIGHT) (seen[i - w] = 1), stack.push(i - w);
    if (py < h - 1 && !seen[i + w] && gray[i + w] >= LIGHT) (seen[i + w] = 1), stack.push(i + w);
  }
  if (over) return null;
  const rows = [];
  for (let r = y0; r <= y1; r++) rows.push(rowMin.has(r) ? [rowMin.get(r), rowMax.get(r)] : null);
  return { n, x0, y0, x1, y1, rows };
}

/** How much of a light area is dark marks (its letters), as a share of its area. */
function inkShare(gray, w, b) {
  let dark = 0;
  let all = 0;
  b.rows.forEach((r, k) => {
    if (!r) return;
    const y = b.y0 + k;
    for (let x = r[0]; x <= r[1]; x++) {
      all++;
      if (gray[y * w + x] < DARK) dark++;
    }
  });
  return all ? dark / all : 0;
}

/** The bubble around (x, y) in a grey picture w×h, or null if there's no bubble-like shape there. */
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
  const b = fillFrom(gray, w, h, seed, new Uint8Array(w * h), w * h * 0.3);
  if (!b) return null;
  // Too small to hold words (the gap inside a letter, a highlight in the art).
  if (b.n < w * h * 0.0015 || b.x1 - b.x0 < w * 0.04 || b.y1 - b.y0 < h * 0.02) return null;
  return b;
}

/** Every bubble and caption box on a page: light shapes, closed, holding letters. */
export function findBubbles(gray, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const step = Math.max(3, Math.round(Math.max(w, h) / 300));
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const i = y * w + x;
      if (seen[i] || gray[i] < LIGHT) continue;
      const b = fillFrom(gray, w, h, i, seen, w * h * 0.15);
      if (!b) continue;
      const bw = b.x1 - b.x0 + 1;
      const bh = b.y1 - b.y0 + 1;
      if (b.x0 <= 1 || b.y0 <= 1 || b.x1 >= w - 2 || b.y1 >= h - 2) continue; // the page's margin, not a bubble
      if (b.n < w * h * 0.0012 || bw < w * 0.035 || bh < h * 0.02) continue;
      if (b.n / (bw * bh) < 0.35) continue; // a long thin gap in the art
      const ink = inkShare(gray, w, b);
      if (ink < 0.02 || ink > 0.55) continue; // no letters in it (a face, the sky), or mostly drawing
      out.push(b);
    }
  }
  return out;
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
      for (let xx = Math.max(0, ax); xx <= Math.min(w - 1, bx); xx++) if (gray[yy * w + xx] < DARK) return true;
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
  return { x0, y0, x1, y1, rows: null };
}

/** The usual height of a line of letters inside a bubble (analysis pixels), from the rows that hold ink. */
function letterHeight(gray, w, b) {
  const runs = [];
  let run = 0;
  const rowHasInk = (k) => {
    const r = b.rows ? b.rows[k] : [b.x0, b.x1];
    if (!r) return false;
    const y = b.y0 + k;
    let n = 0;
    for (let x = r[0]; x <= r[1]; x++) if (gray[y * w + x] < DARK) n++;
    return n >= 2;
  };
  for (let k = 0; k <= b.y1 - b.y0; k++) {
    if (rowHasInk(k)) run++;
    else if (run) runs.push(run), (run = 0);
  }
  if (run) runs.push(run);
  const lines = runs.filter((r) => r >= 3).sort((p, q) => p - q);
  return lines.length ? lines[lines.length >> 1] : 0;
}

// ---------------------------------------------------------------- reading a region

/** Otsu's threshold: the grey level that best splits letters from paper. */
function otsu(hist, total) {
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let at = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) (best = between), (at = t);
  }
  return at;
}

/**
 * Read one region (a bubble with its row spans, or a plain box). Positions
 * come back in picture pixels: { lines: [{ words: [{ text, x0, y0, x1, y1 }] }], text, confidence }.
 */
async function readRegion(img, a, sx, b, lang) {
  const k = a.k;
  // The outline is left out: the mask is drawn in from the edge by a few per cent.
  const inset = b.rows ? Math.max(2, Math.round(Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.05)) : 0;
  const box = { x: sx + b.x0 / k, y: b.y0 / k, w: (b.x1 - b.x0 + 1) / k, h: (b.y1 - b.y0 + 1) / k };
  // Letters about 34 px tall are what the engine reads best.
  const lh = letterHeight(a.g, a.w, b) / k;
  const scale = lh > 0 ? Math.max(0.6, Math.min(4, 34 / lh)) : Math.max(1, Math.min(4, 1100 / Math.max(box.w, box.h)));
  const pad = 24;
  const cw = Math.round(box.w * scale) + 2 * pad;
  const ch = Math.round(box.h * scale) + 2 * pad;
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, box.x, box.y, box.w, box.h, pad, pad, box.w * scale, box.h * scale);
  const d = ctx.getImageData(0, 0, cw, ch);
  const px = d.data;
  const f = scale / k; // analysis pixels → canvas pixels
  const inside = new Uint8Array(cw * ch);
  const hist = new Uint32Array(256);
  let total = 0;
  for (let y = 0; y < ch; y++) {
    const ay = Math.floor((y - pad) / f); // row within the region
    let lo = pad;
    let hi = cw - pad;
    if (b.rows) {
      const r = ay >= inset && ay <= b.y1 - b.y0 - inset ? b.rows[ay] : null;
      lo = r ? pad + (r[0] - b.x0 + inset + 0.5) * f : 1e9;
      hi = r ? pad + (r[1] - b.x0 - inset + 0.5) * f : -1;
    } else if (y < pad || y >= ch - pad) {
      lo = 1e9;
    }
    for (let x = 0; x < cw; x++) {
      if (x < lo || x > hi) continue;
      const j = (y * cw + x) * 4;
      const v = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
      inside[y * cw + x] = 1;
      hist[v | 0]++;
      total++;
      px[j] = v;
    }
  }
  // Clean black and white: letters black, paper (and everything outside the bubble) white.
  const t = total ? otsu(hist, total) : 128;
  for (let i = 0, j = 0; i < inside.length; i++, j += 4) {
    const v = inside[i] ? (px[j] <= t ? 0 : 255) : 255;
    px[j] = px[j + 1] = px[j + 2] = v;
    px[j + 3] = 255;
  }
  ctx.putImageData(d, 0, 0);
  const worker = await workerFor(lang);
  await worker.setParameters({
    tessedit_pageseg_mode: lang === 'ja-v' ? '5' : '6',
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
    tessedit_char_blacklist: lang === 'en' ? '|{}[]<>@#$%^&*_=+~`\\' : '',
  });
  const { data } = await worker.recognize(c, {}, { text: true, blocks: true });
  c.width = c.height = 0;
  const back = (bb) => ({ x0: box.x + (bb.x0 - pad) / scale, y0: box.y + (bb.y0 - pad) / scale, x1: box.x + (bb.x1 - pad) / scale, y1: box.y + (bb.y1 - pad) / scale });
  const lines = [];
  for (const bl of data.blocks || []) {
    for (const p of bl.paragraphs || []) {
      for (const l of p.lines || []) {
        const words = (l.words || [])
          // Specks the engine took for marks are dropped; real one-letter words ("I", "a") stay.
          .filter((w) => w.text && w.text.trim() && !(w.confidence < 25 && w.text.replace(/[^\p{L}\p{N}]/gu, '').length < 2 && !/^[IAa][.,!?…'’]*$/.test(w.text.trim())))
          .map((w) => Object.assign({ text: w.text.trim(), conf: w.confidence }, back(w.bbox)));
        if (words.length) lines.push({ words });
      }
    }
  }
  tidyWords(lines, lang);
  const text = lines.map((l) => l.words.map((w) => w.text).join(lang === 'en' ? ' ' : '')).join(lang === 'en' ? ' ' : '');
  return { lines, text: text.replace(/(\w)- (\w)/g, '$1$2').trim(), box, confidence: data.confidence || 0 };
}

// Words that often follow "I" (to tell "ILEFT" from a word that starts with I).
const FOLLOWS_I = new Set(
  ('am was have had can could will would should did do dont didnt cant wont wasnt havent know knew think thought want wanted need needed ' +
    'left like liked love loved see saw said told got get just never always really mean meant guess feel felt hope wish made make came come ' +
    'went go found heard took gave tried looked believe remember forgot used must may might also still only already am m ll ve d ' +
    'won lost hate miss missed bet swear promise understand see wonder agree suppose figured noticed called asked tell owe let am').split(' '),
);

/**
 * What lettering often turns into, put right word by word (so the words on
 * the page and the text read stay the same): a lone "1", "7" or "|" between
 * words is "I"; "1s", "1t" are "is", "it"; comic capitals become ordinary
 * sentences (better to translate and to hear).
 */
export function tidyWords(lines, lang) {
  if (lang !== 'en') return;
  const all = [];
  for (const l of lines) for (const w of l.words) all.push(w);
  const numbers = all.filter((w) => /\d/.test(w.text) && !/[A-Za-z]/.test(w.text)).length;
  for (const w of all) {
    let t = w.text.replace(/[|]/g, 'I');
    if (/[A-Za-z]/.test(t)) {
      // (No look-behind in these patterns: older Safari doesn't know it.)
      t = t.replace(/^1(?=[a-z]{1,3}\b)/, 'i').replace(/([A-Za-z])0(?=[A-Za-z])/g, '$1o').replace(/([A-Za-z])1(?=[A-Za-z])/g, '$1l').replace(/([A-Za-z])5(?=[A-Za-z])/g, '$1s');
    } else if (/^[17]([.,!?…'’"”]*)$/.test(t) && numbers <= 1 && all.length > 2) {
      t = 'I' + t.slice(1);
    }
    w.text = t;
  }
  // A narrow "I" glued to the next word ("ILEFT"): split off when the rest is a common word.
  for (const w of all) {
    const m = /^I([A-Za-z]+)([^A-Za-z]*)$/.exec(w.text);
    if (m && m[1].length > 1 && FOLLOWS_I.has(m[1].toLowerCase()) && !FOLLOWS_I.has(w.text.toLowerCase())) w.text = `I ${m[1]}${m[2]}`;
  }
  const letters = all.map((w) => w.text).join('').replace(/[^A-Za-z]/g, '');
  if (letters.length > 3 && letters === letters.toUpperCase()) {
    let start = true;
    for (const w of all) {
      let t = w.text.toLowerCase();
      if (/^i(['’](m|ll|ve|d))?[^a-z]*$/.test(t)) t = 'I' + t.slice(1);
      if (start) t = t.replace(/[a-z]/, (c) => c.toUpperCase());
      w.text = t;
      start = /[.!?…]["'”’)]*$/.test(t);
    }
  }
}

/** Lines of a bubble as one passage (for older callers and tests). */
export function tidy(raw, lang) {
  const lines = String(raw)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => ({ words: l.trim().split(/\s+/).map((text) => ({ text })) }));
  tidyWords(lines, lang);
  const sep = lang === 'en' ? ' ' : '';
  return lines.map((l) => l.words.map((w) => w.text).join(sep)).join(sep).replace(/(\w)- (\w)/g, '$1$2').trim();
}

// ---------------------------------------------------------------- the two ways in

/**
 * Read the words at (ix, iy) of a picture (pixels of `img`, within the area
 * sx..sx+sw it shows). lang: 'en' | 'ja' | 'ja-v'.
 * Returns { text, lines, box (picture pixels), bubble: whether a bubble was found }.
 */
export function readAt(img, { sx = 0, sw = img.naturalWidth || img.width, ix, iy, lang = 'en' }) {
  return queued(async () => {
    const ih = img.naturalHeight || img.height;
    const a = grayOf(img, sx, 0, sw, ih);
    const ax = Math.round((ix - sx) * a.k);
    const ay = Math.round(iy * a.k);
    let b = findBubble(a.g, a.w, a.h, ax, ay);
    const bubble = !!b;
    if (!b) b = textBlock(a.g, a.w, a.h, ax, ay);
    if (!b || b.x1 - b.x0 > a.w * 0.75 || b.y1 - b.y0 > a.h * 0.4) {
      // Neither: a window around the point.
      const w = a.w * 0.4;
      const h = a.h * 0.18;
      const x0 = Math.round(Math.max(0, Math.min(a.w - w, ax - w / 2)));
      const y0 = Math.round(Math.max(0, Math.min(a.h - h, ay - h / 2)));
      b = { x0, y0, x1: Math.round(x0 + w), y1: Math.round(y0 + h), rows: null };
    } else if (!bubble) {
      const p = 6;
      b = { x0: Math.max(0, b.x0 - p), y0: Math.max(0, b.y0 - p), x1: Math.min(a.w - 1, b.x1 + p), y1: Math.min(a.h - 1, b.y1 + p), rows: null };
    }
    const res = await readRegion(img, a, sx, b, lang);
    return Object.assign(res, { bubble });
  });
}

/**
 * All the bubbles of a page, read, in reading order: [{ box, lines, text }].
 * rtl: manga (right to left). onProgress(done, total) as it goes.
 */
export function readPage(img, { sx = 0, sw = img.naturalWidth || img.width, lang = 'en', rtl = false }, onProgress = () => {}) {
  return queued(async () => {
    const ih = img.naturalHeight || img.height;
    const a = grayOf(img, sx, 0, sw, ih);
    const found = findBubbles(a.g, a.w, a.h);
    const out = [];
    for (let i = 0; i < found.length; i++) {
      onProgress(i, found.length);
      const r = await readRegion(img, a, sx, found[i], lang);
      const letters = r.text.replace(/[^\p{L}]/gu, '').length;
      if (letters >= 2 && r.confidence >= 45) out.push(r);
    }
    onProgress(found.length, found.length);
    return inReadingOrder(out, rtl);
  });
}

/**
 * Reading order: bubbles side by side (overlapping in height) form a row; rows
 * from the top; within a row from the left, or from the right in manga.
 */
export function inReadingOrder(list, rtl) {
  const items = list.slice().sort((p, q) => p.box.y - q.box.y);
  const rows = [];
  for (const it of items) {
    const row = rows.find((r) => {
      const top = Math.max(r.y0, it.box.y);
      const bottom = Math.min(r.y1, it.box.y + it.box.h);
      return bottom - top > Math.min(r.y1 - r.y0, it.box.h) * 0.4;
    });
    if (row) {
      row.items.push(it);
      row.y0 = Math.min(row.y0, it.box.y);
      row.y1 = Math.max(row.y1, it.box.y + it.box.h);
    } else rows.push({ y0: it.box.y, y1: it.box.y + it.box.h, items: [it] });
  }
  rows.sort((p, q) => p.y0 - q.y0);
  const out = [];
  for (const r of rows) {
    r.items.sort((p, q) => (rtl ? q.box.x + q.box.w - (p.box.x + p.box.w) : p.box.x - q.box.x));
    out.push(...r.items);
  }
  return out;
}
