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
const ERODE = 1; // how narrow a gap in a bubble's outline a fill can't pass (analysis pixels, each side)

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
 * Where a fill may go: light pixels whose neighbours (within `r`) are light too, so a fill
 * doesn't leak out of a bubble through a gap of a pixel or two in its outline.
 */
export function passable(gray, w, h, r = 1) {
  let m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = gray[i] >= LIGHT ? 1 : 0;
  for (let k = 0; k < r; k++) {
    const n = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        n[i] = m[i] && m[i - 1] && m[i + 1] && m[i - w] && m[i + w] && m[i - w - 1] && m[i - w + 1] && m[i + w - 1] && m[i + w + 1] ? 1 : 0;
      }
    }
    m = n;
  }
  return m;
}

/**
 * The light area containing pixel `seed`: its extent and, per row, the span
 * from its first to its last pixel (letters inside it are holes, still
 * inside the span). null when it grows past `max` pixels (the page itself).
 * Its pixels are marked `id` in `seen`, so what lies in it can be told later.
 */
function fillFrom(pass, w, h, seed, seen, max, id = 1) {
  const stack = [seed];
  seen[seed] = id;
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
    if (px > 0 && !seen[i - 1] && pass[i - 1]) (seen[i - 1] = id), stack.push(i - 1);
    if (px < w - 1 && !seen[i + 1] && pass[i + 1]) (seen[i + 1] = id), stack.push(i + 1);
    if (py > 0 && !seen[i - w] && pass[i - w]) (seen[i - w] = id), stack.push(i - w);
    if (py < h - 1 && !seen[i + w] && pass[i + w]) (seen[i + w] = id), stack.push(i + w);
  }
  if (over) return null;
  const rows = [];
  for (let r = y0; r <= y1; r++) rows.push(rowMin.has(r) ? [rowMin.get(r), rowMax.get(r)] : null);
  return { n, x0, y0, x1, y1, rows, id, label: seen };
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
export function findBubble(gray, w, h, x, y, pass = passable(gray, w, h, ERODE)) {
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
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && pass[yy * w + xx]) {
          seed = yy * w + xx;
          break;
        }
      }
    }
  }
  if (seed < 0) return null;
  const b = fillFrom(pass, w, h, seed, new Int32Array(w * h), w * h * 0.3);
  if (!b) return null;
  // Too small to hold words (the gap inside a letter, a highlight in the art).
  if (b.n < w * h * 0.0015 || b.x1 - b.x0 < w * 0.04 || b.y1 - b.y0 < h * 0.02) return null;
  return b;
}

/** Every bubble and caption box on a page: light shapes, closed, holding letters. */
export function findBubbles(gray, w, h, pass = passable(gray, w, h, ERODE)) {
  const seen = new Int32Array(w * h);
  const sizes = [0]; // how big each light area is (by its mark in `seen`)
  let id = 0;
  const out = [];
  const step = Math.max(3, Math.round(Math.max(w, h) / 300));
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const i = y * w + x;
      if (seen[i] || !pass[i]) continue;
      const b = fillFrom(pass, w, h, i, seen, w * h * 0.15, ++id);
      sizes[id] = b ? b.n : Infinity;
      if (!b) continue;
      b.sizes = sizes;
      const bw = b.x1 - b.x0 + 1;
      const bh = b.y1 - b.y0 + 1;
      if (b.x0 <= 1 || b.y0 <= 1 || b.x1 >= w - 2 || b.y1 >= h - 2) continue; // the page's margin, not a bubble
      if (b.n < w * h * 0.0012 || bw < w * 0.035 || bh < h * 0.02) continue;
      if (b.n / (bw * bh) < 0.35) continue; // a long thin gap in the art
      const ink = inkShare(gray, w, b);
      if (ink < 0.005 || ink > 0.55) continue; // no letters in it (a face, the sky), or mostly drawing
      out.push(b);
    }
  }
  return out;
}

/**
 * The panels of a page: what the light gutters between them (the paper
 * reached from the page's edges) leave. Boxes as shares of the picture
 * (0 to 1). None when the page has no gutters (art to the edges, one panel).
 */
export function findPanels(gray, w, h) {
  const gutter = new Uint8Array(w * h);
  const stack = [];
  const seed = (i) => {
    if (!gutter[i] && gray[i] >= LIGHT) (gutter[i] = 1), stack.push(i);
  };
  for (let x = 0; x < w; x++) seed(x), seed((h - 1) * w + x);
  for (let y = 0; y < h; y++) seed(y * w), seed(y * w + w - 1);
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }
  const seen = new Uint8Array(w * h);
  const panels = [];
  for (let i0 = 0; i0 < w * h; i0++) {
    if (gutter[i0] || seen[i0]) continue;
    let n = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    seen[i0] = 1;
    stack.push(i0);
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j >= 0 && j < w * h && !gutter[j] && !seen[j]) (seen[j] = 1), stack.push(j);
      }
    }
    if (n < w * h * 0.01 || (x1 - x0) * (y1 - y0) < w * h * 0.015) continue; // a speck, a sound effect in the gutter
    panels.push({ x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h });
  }
  // One panel covering the page: no gutters to go by.
  if (panels.length < 2 && (!panels[0] || (panels[0].x1 - panels[0].x0) * (panels[0].y1 - panels[0].y0) > 0.8)) return [];
  return panels;
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

/**
 * The groups of letters inside a light region (analysis pixels): marks of about a letter's size,
 * joined while they lie within a letter or so of each other. A bubble of several lobes, each with
 * its own words, has a group per lobe. Returns [{ x0, y0, x1, y1, marks }], biggest first; marks
 * that aren't letter-like (a line of the art, a dot of tone) are left out.
 */
export function letterGroups(gray, w, b, lh) {
  const inset = b.rows ? Math.max(1, Math.round(Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.05)) : 0;
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const inside = (x, y) => {
    const k = y - b.y0;
    if (k < inset || k > bh - 1 - inset) return false;
    const r = b.rows ? b.rows[k] : [b.x0, b.x1];
    return !!r && x >= r[0] + inset && x <= r[1] - inset;
  };
  const seen = new Uint8Array(bw * bh);
  const marks = [];
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const li = (y - b.y0) * bw + (x - b.x0);
      if (seen[li] || gray[y * w + x] >= DARK || !inside(x, y)) continue;
      // One mark: the dark pixels touching this one.
      let x0 = x;
      let x1 = x;
      let y0 = y;
      let y1 = y;
      let n = 0;
      const stack = [li];
      const at = [];
      seen[li] = 1;
      while (stack.length) {
        const j = stack.pop();
        const px = b.x0 + (j % bw);
        const py = b.y0 + ((j - (j % bw)) / bw);
        n++;
        at.push(py * w + px);
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const qx = px + dx;
            const qy = py + dy;
            if (qx < b.x0 || qx > b.x1 || qy < b.y0 || qy > b.y1) continue;
            const q = (qy - b.y0) * bw + (qx - b.x0);
            if (seen[q] || gray[qy * w + qx] >= DARK || !inside(qx, qy)) continue;
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
      marks.push({ x0, y0, x1, y1, n, at });
    }
  }
  const size = lh || 12;
  // In this region: the paper around the mark is this region's (not a neighbouring bubble's within the spans).
  const h = b.label ? b.label.length / w : 0;
  const ours = (m) => {
    if (!b.label) return true;
    const mx = (m.x0 + m.x1) >> 1;
    const my = (m.y0 + m.y1) >> 1;
    let n = 0;
    for (const d of [3, 5]) {
      for (const [x, y] of [[m.x0 - d, my], [m.x1 + d, my], [mx, m.y0 - d], [mx, m.y1 + d]]) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const v = b.label[y * w + x];
        if (v === b.id) n++;
        // Another light area next to it (bigger than the inside of a letter): a piece of the outline, or the art outside.
        else if (v && !(b.sizes && b.sizes[v] < size * size * 1.5)) return false;
      }
    }
    return n >= 2;
  };
  // Letters (and their dots, commas), or a word of letters that touch: not much taller than a line,
  // not long thin strokes.
  const letterLike = (m) => {
    const mw = m.x1 - m.x0 + 1;
    const mh = m.y1 - m.y0 + 1;
    return mh <= size * 2.2 && (mw <= size * 3 || (mw <= size * 9 && mh >= size * 0.5)) && m.n >= 2;
  };
  const letters = marks.filter((m) => letterLike(m) && ours(m));
  // Join marks lying close: within about a letter sideways, a line up or down, and (in a bubble)
  // with only its own paper between them: the lobes of a bubble keep their own words.
  const gx = size * 1.0;
  const gy = size * 1.2;
  const clear = (p, q) => {
    if (!b.label) return true;
    const ax = (p.x0 + p.x1) / 2;
    const ay = (p.y0 + p.y1) / 2;
    const bx = (q.x0 + q.x1) / 2;
    const by = (q.y0 + q.y1) / 2;
    for (let t = 1; t < 10; t++) {
      const x = Math.round(ax + ((bx - ax) * t) / 10);
      const y = Math.round(ay + ((by - ay) * t) / 10);
      const v = b.label[y * w + x];
      if (v && v !== b.id) return false; // another light area lies between
      if (!v && gray[y * w + x] >= LIGHT && !inside(x, y)) return false; // outside this bubble
    }
    return true;
  };
  const up = letters.map((_, i) => i);
  const root = (i) => {
    while (up[i] !== i) i = up[i] = up[up[i]];
    return i;
  };
  const order = letters.map((_, i) => i).sort((p, q) => letters[p].x0 - letters[q].x0);
  for (let oi = 0; oi < order.length; oi++) {
    const p = letters[order[oi]];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const q = letters[order[oj]];
      if (q.x0 > p.x1 + gx) break; // (sorted by left edge: none further on can be near)
      if (q.y0 > p.y1 + gy || p.y0 > q.y1 + gy) continue;
      const a = root(order[oi]);
      const c = root(order[oj]);
      if (a !== c && clear(p, q)) up[a] = c;
    }
  }
  const byRoot = new Map();
  letters.forEach((m, i) => {
    const r = root(i);
    const g = byRoot.get(r);
    if (!g) byRoot.set(r, { x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1, marks: 1, at: m.at.slice() });
    else {
      g.x0 = Math.min(g.x0, m.x0);
      g.y0 = Math.min(g.y0, m.y0);
      g.x1 = Math.max(g.x1, m.x1);
      g.y1 = Math.max(g.y1, m.y1);
      g.marks++;
      for (const k of m.at) g.at.push(k);
    }
  });
  const groups = [...byRoot.values()];
  return groups.filter((g) => g.marks >= 2).sort((p, q) => q.marks - p.marks);
}

/**
 * Words outside the bubbles found: groups of letters on light paper (a bubble
 * whose outline runs into the panel's edge, lettering on the page). Groups in
 * a found bubble, on tone or art, or too long for words are left out.
 */
function looseGroups(gray, w, h, bubbles, lh) {
  const page = { x0: 0, y0: 0, x1: w - 1, y1: h - 1, rows: null };
  const label = bubbles.length ? bubbles[0].label : null;
  const taken = new Set(bubbles.map((b) => b.id));
  const out = [];
  for (const g of letterGroups(gray, w, page, lh)) {
    if (g.marks < 3) continue;
    const gw = g.x1 - g.x0 + 1;
    const gh = g.y1 - g.y0 + 1;
    if (gw > w * 0.4 || gh > h * 0.2) continue;
    // Light around and between the letters (paper), and not inside a bubble already read.
    const m = Math.max(2, Math.round(lh * 0.6));
    let light = 0;
    let all = 0;
    let inBubble = 0;
    for (let y = Math.max(0, g.y0 - m); y <= Math.min(h - 1, g.y1 + m); y++) {
      for (let x = Math.max(0, g.x0 - m); x <= Math.min(w - 1, g.x1 + m); x++) {
        all++;
        if (gray[y * w + x] >= LIGHT) light++;
        if (label && taken.has(label[y * w + x])) inBubble++;
      }
    }
    if (light < all * 0.6 || inBubble > all * 0.15) continue;
    out.push({ x0: Math.max(0, g.x0 - m), y0: Math.max(0, g.y0 - m), x1: Math.min(w - 1, g.x1 + m), y1: Math.min(h - 1, g.y1 + m), rows: null });
  }
  return out;
}

/** The part of region b (a picture w wide) inside group g's box (grown by `pad`), keeping only g's letters. */
function within(b, g, pad, w) {
  const x0 = Math.max(b.x0, g.x0 - pad);
  const x1 = Math.min(b.x1, g.x1 + pad);
  const y0 = Math.max(b.y0, g.y0 - pad);
  const y1 = Math.min(b.y1, g.y1 + pad);
  const rows = [];
  for (let y = y0; y <= y1; y++) {
    const r = b.rows ? b.rows[y - b.y0] : [b.x0, b.x1];
    rows.push(r && r[1] >= x0 && r[0] <= x1 ? [Math.max(r[0], x0), Math.min(r[1], x1)] : null);
  }
  // Only the group's own letters (and a little around them, for thin strokes) are read: no art or outline between lobes.
  const bw = x1 - x0 + 1;
  const keep = new Uint8Array(bw * (y1 - y0 + 1));
  const r = Math.max(2, Math.round(pad / 2));
  for (const i of g.at) {
    const gx = i % w;
    const gy = (i - gx) / w;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const xx = gx + dx - x0;
        const yy = gy + dy - y0;
        if (xx >= 0 && yy >= 0 && xx < bw && yy <= y1 - y0) keep[yy * bw + xx] = 1;
      }
    }
  }
  return { x0, y0, x1, y1, rows, part: true, keep };
}

/**
 * Is what was read like words? Pictures read as letters come out as runs of
 * short scraps, digits and signs the engine wasn't sure of ("6 0 0 0 8", "™ v").
 */
export function wordLike(r, lang) {
  const words = [];
  for (const l of r.lines) for (const w of l.words) words.push(w);
  if (!words.length) return false;
  const text = words.map((w) => w.text).join(' ');
  const letters = text.replace(/[^\p{L}]/gu, '').length;
  const signs = text.replace(/[\p{L}\p{N}\s.,!?…'’"“”\-–—~()]/gu, '').length;
  const digits = text.replace(/[^\p{N}]/gu, '').length;
  if (letters < 2 || signs > Math.max(1, letters * 0.15)) return false;
  if (digits > letters) return false;
  const sure = words.filter((w) => (w.conf == null ? 100 : w.conf) >= 60).length;
  if (r.confidence < 50 || sure < words.length * 0.5) return false;
  if (lang === 'en') {
    // Real lettering has words of several letters, with vowels.
    const real = words.filter((w) => /[A-Za-z]{2,}/.test(w.text) && /[aeiouyAEIOUY]/.test(w.text)).length;
    const one = words.filter((w) => /^[IAaOo][.,!?…'’]*$/.test(w.text)).length;
    if (real + one < Math.max(1, words.length * 0.5)) return false;
  }
  return true;
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
 * Read a bubble: each group of letters in it on its own when there are
 * several (a bubble of several lobes), else the whole bubble. Returns one
 * result per group (see readRegion).
 */
async function readBubble(img, a, sx, b, lang) {
  if (lang === 'en' && b.rows) {
    const lh = letterHeight(a.g, a.w, b);
    const groups = letterGroups(a.g, a.w, b, lh);
    if (groups.length > 1) {
      const pad = Math.max(3, Math.round((lh || 12) * 0.8));
      const out = [];
      for (const g of groups) out.push(await readRegion(img, a, sx, within(b, g, pad, a.w), lang));
      return out;
    }
  }
  return [await readRegion(img, a, sx, b, lang)];
}

/**
 * Read one region (a bubble with its row spans, or a plain box). Positions
 * come back in picture pixels: { lines: [{ words: [{ text, x0, y0, x1, y1 }] }], text, confidence }.
 */
async function readRegion(img, a, sx, b, lang) {
  const k = a.k;
  // The outline is left out: the mask is drawn in from the edge by a few per cent.
  const inset = b.rows && !b.part ? Math.max(2, Math.round(Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.05)) : 0;
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
    const kr = b.keep && ay >= 0 && ay <= b.y1 - b.y0 ? ay * (b.x1 - b.x0 + 1) : -1;
    for (let x = 0; x < cw; x++) {
      if (x < lo || x > hi) continue;
      const j = (y * cw + x) * 4;
      const v = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
      // (A group of a bubble's letters: only near those letters.)
      inside[y * cw + x] = !b.keep || (kr >= 0 && b.keep[kr + Math.floor((x - pad) / f)]) ? 1 : 0;
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
    // A bubble of several lobes: the words of the lobe pressed.
    const all = bubble ? await readBubble(img, a, sx, b, lang) : [await readRegion(img, a, sx, b, lang)];
    const dist = (r) => Math.max(0, r.box.x - ix, ix - (r.box.x + r.box.w)) + Math.max(0, r.box.y - iy, iy - (r.box.y + r.box.h));
    const res = all.filter((r) => r.text).sort((p, q) => dist(p) - dist(q))[0] || all[0];
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
    if (lang === 'en') {
      // Lettering outside them, about the size of the bubbles' own.
      const sizes = found.map((b) => letterHeight(a.g, a.w, b)).filter(Boolean).sort((p, q) => p - q);
      found.push(...looseGroups(a.g, a.w, a.h, found, sizes.length ? sizes[sizes.length >> 1] : 12));
    }
    const out = [];
    for (let i = 0; i < found.length; i++) {
      onProgress(i, found.length);
      for (const r of await readBubble(img, a, sx, found[i], lang)) {
        if (lang === 'en' ? wordLike(r, lang) : r.text.replace(/[^\p{L}]/gu, '').length >= 2 && r.confidence >= 45) out.push(r);
      }
    }
    onProgress(found.length, found.length);
    // (The panels too: read aloud, the view keeps the panel of the bubble being read in sight.)
    return Object.assign(inReadingOrder(out, rtl), { panels: findPanels(a.g, a.w, a.h) });
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
