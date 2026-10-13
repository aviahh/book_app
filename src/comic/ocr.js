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

// For testing: keep the picture each region was read from (res.image).
export const debug = { images: false, trace: null, stats: null };
const timed = async (kind, job) => {
  const t = performance.now();
  const out = await job;
  if (debug.stats) (debug.stats[kind] = debug.stats[kind] || [0, 0]), (debug.stats[kind][0] += 1), (debug.stats[kind][1] += performance.now() - t);
  return out;
};

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
      // The page's margin, not a bubble (a bubble cut off by the page's edge is much smaller).
      // (The margin runs right round the page; a bubble cut off by an edge doesn't.)
      if ((b.x0 <= 1 || b.y0 <= 1 || b.x1 >= w - 2 || b.y1 >= h - 2) && (bw > w * 0.6 || bh > h * 0.6)) continue;
      if (b.n < w * h * 0.0012 || bw < w * 0.035 || bh < h * 0.02) continue;
      if (b.n / (bw * bh) < 0.25) continue; // a long thin gap in the art
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
 * The lobes of a bubble: bubbles drawn joined (two or three ovals overlapping)
 * meet at notches in the outline, where it turns sharply inwards. A lobe is
 * cut off along a short line between two such notches, when that leaves two
 * good-sized parts and the line is short beside them (a cloud's bumps, a
 * tail's base, are left alone). Returns a lobe number per pixel of the
 * bubble's box (0 outside it, or on a cut).
 */
export function lobesOf(b, w, gray) {
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const N = bw * bh;
  // The bubble's paper, with the light edge the fill kept off (next to letters and the outline) given back,
  // so a letter close to the outline is still inside.
  const reg = new Uint8Array(N);
  for (let j = 0; j < N; j++) reg[j] = b.label[(b.y0 + ((j / bw) | 0)) * w + b.x0 + (j % bw)] === b.id ? 1 : 0;
  if (gray) {
    for (let k = 0; k <= ERODE; k++) {
      const grow = reg.slice();
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const j = y * bw + x;
          if (reg[j] || gray[(b.y0 + y) * w + b.x0 + x] < LIGHT) continue;
          if ((x > 0 && reg[j - 1]) || (x < bw - 1 && reg[j + 1]) || (y > 0 && reg[j - bw]) || (y < bh - 1 && reg[j + bw])) grow[j] = 1;
        }
      }
      reg.set(grow);
    }
  }
  const ours = (j) => reg[j] === 1;
  // The bubble filled: what isn't reached from the box's edge without crossing it (its letters are inside).
  const fill = new Uint8Array(N).fill(1);
  const stack = [];
  const seed = (j) => {
    if (fill[j] && !ours(j)) (fill[j] = 0), stack.push(j);
  };
  for (let x = 0; x < bw; x++) seed(x), seed((bh - 1) * bw + x);
  for (let y = 0; y < bh; y++) seed(y * bw), seed(y * bw + bw - 1);
  while (stack.length) {
    const j = stack.pop();
    const x = j % bw;
    if (x > 0) seed(j - 1);
    if (x < bw - 1) seed(j + 1);
    if (j >= bw) seed(j - bw);
    if (j < N - bw) seed(j + bw);
  }
  let area = 0;
  for (let j = 0; j < N; j++) area += fill[j];
  // How much of a square around each outline point is bubble: about half on a straight stretch, more in a notch.
  const S = new Int32Array((bw + 1) * (bh + 1));
  for (let y = 0; y < bh; y++) {
    let row = 0;
    for (let x = 0; x < bw; x++) {
      row += fill[y * bw + x];
      S[(y + 1) * (bw + 1) + x + 1] = S[y * (bw + 1) + x + 1] + row;
    }
  }
  // How much of a square around each outline point is bubble: about half on a straight stretch, more in a
  // notch. Looked at on two scales: the notches between small bubbles are small.
  const notches = [];
  let R = 0;
  for (const k of [0.05, 0.09]) {
    R = Math.max(3, Math.round(Math.sqrt(area) * k));
    const share = (x, y) => {
      const x0 = Math.max(0, x - R);
      const y0 = Math.max(0, y - R);
      const x1 = Math.min(bw, x + R + 1);
      const y1 = Math.min(bh, y + R + 1);
      const n = S[y1 * (bw + 1) + x1] - S[y0 * (bw + 1) + x1] - S[y1 * (bw + 1) + x0] + S[y0 * (bw + 1) + x0];
      return n / ((2 * R + 1) * (2 * R + 1));
    };
    const edge = [];
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const j = y * bw + x;
        if (!fill[j]) continue;
        if (x === 0 || y === 0 || x === bw - 1 || y === bh - 1 || !fill[j - 1] || !fill[j + 1] || !fill[j - bw] || !fill[j + bw]) {
          const c = share(x, y);
          if (c >= 0.64) edge.push({ x, y, c });
        }
      }
    }
    // The deepest point of each notch.
    edge.sort((p, q) => q.c - p.c);
    for (const e of edge) if (!notches.some((n) => Math.abs(n.x - e.x) <= R * 1.5 && Math.abs(n.y - e.y) <= R * 1.5)) notches.push(e);
  }
  R = Math.max(3, Math.round(Math.sqrt(area) * 0.05));
  const cut = new Uint8Array(N);
  const parts = () => {
    const lab = new Int32Array(N);
    const sizes = [0];
    for (let j0 = 0; j0 < N; j0++) {
      if (!fill[j0] || cut[j0] || lab[j0]) continue;
      const id = sizes.length;
      let n = 0;
      lab[j0] = id;
      stack.push(j0);
      while (stack.length) {
        const j = stack.pop();
        n++;
        const x = j % bw;
        for (const k of [x > 0 ? j - 1 : -1, x < bw - 1 ? j + 1 : -1, j - bw, j + bw]) {
          if (k >= 0 && k < N && fill[k] && !cut[k] && !lab[k]) (lab[k] = id), stack.push(k);
        }
      }
      sizes.push(n);
    }
    return { lab, sizes };
  };
  const line = (p, q, f) => {
    const steps = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) * 1.5);
    for (let t = 0; t <= steps; t++) {
      const x = Math.round(p.x + ((q.x - p.x) * t) / steps);
      const y = Math.round(p.y + ((q.y - p.y) * t) / steps);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < bw && yy < bh) f(yy * bw + xx);
      }
    }
  };
  // Shortest cuts first.
  const pairs = [];
  for (let a = 0; a < notches.length && a < 16; a++) {
    for (let c = a + 1; c < notches.length && c < 16; c++) {
      const len = Math.hypot(notches[a].x - notches[c].x, notches[a].y - notches[c].y);
      if (len > R * 2) pairs.push({ p: notches[a], q: notches[c], len });
    }
  }
  pairs.sort((p, q) => p.len - q.len);
  let made = 0;
  for (const pr of pairs) {
    if (made >= 3) break;
    // Across the bubble's own paper (not out over the art).
    let inside = 0;
    let all = 0;
    line(pr.p, pr.q, (k) => (all++, (inside += fill[k] ? 1 : 0)));
    if (inside < all * 0.92) continue;
    const before = parts();
    const mine = []; // (pixels this cut marks: taking it back leaves earlier cuts whole)
    line(pr.p, pr.q, (k) => !cut[k] && (mine.push(k), (cut[k] = 1)));
    const after = parts();
    // Two parts of good size where there was one, and the cut short beside them.
    const big = after.sizes.filter((n) => n >= area * 0.06).length;
    const was = before.sizes.filter((n) => n >= area * 0.06).length;
    // A neck: the cut much shorter than both parts are wide along it (cutting across a plain
    // oval, the parts are no wider than the cut).
    let ok = big > was;
    if (ok) {
      const ux = (pr.q.x - pr.p.x) / pr.len;
      const uy = (pr.q.y - pr.p.y) / pr.len;
      const mx = (pr.p.x + pr.q.x) / 2;
      const my = (pr.p.y + pr.q.y) / 2;
      // The parts on either side of the cut's middle.
      const side = (sgn) => {
        const x = Math.round(mx - uy * sgn * 3);
        const y = Math.round(my + ux * sgn * 3);
        return x >= 0 && y >= 0 && x < bw && y < bh ? after.lab[y * bw + x] : 0;
      };
      const sa = side(1);
      const sb = side(-1);
      ok = !!sa && !!sb && sa !== sb && after.sizes[sa] >= area * 0.06 && after.sizes[sb] >= area * 0.06;
      if (ok) {
        const span = (id) => {
          let lo = Infinity;
          let hi = -Infinity;
          for (let j = 0; j < N; j++) {
            if (after.lab[j] !== id) continue;
            const t = (j % bw) * ux + ((j / bw) | 0) * uy;
            if (t < lo) lo = t;
            if (t > hi) hi = t;
          }
          return hi - lo;
        };
        ok = pr.len < Math.min(span(sa), span(sb)) * 0.92;
      }
    }
    if (ok) made++;
    else for (const k of mine) cut[k] = 0;
  }
  return parts().lab;
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
  // The letters' size: the usual height of the marks of letter-like size (more reliable than the
  // line height when lines sit close), else the given one.
  const size = (() => {
    const hs = marks.filter((m) => m.n >= 4 && m.y1 - m.y0 >= 3 && m.y1 - m.y0 < Math.max(40, (lh || 12) * 3) && m.x1 - m.x0 < Math.max(40, (lh || 12) * 3)).map((m) => m.y1 - m.y0 + 1).sort((p, q) => p - q);
    return hs.length >= 3 ? hs[hs.length >> 1] : lh || 12;
  })();
  // In this region: the paper around the mark is this region's (not a neighbouring bubble's within the spans).
  const h = b.label ? b.label.length / w : 0;
  // A bubble: its lobes (for a bubble drawn joined); each letter is in the lobe holding most of it.
  const lobe = b.label && b.rows ? lobesOf(b, w, gray) : null;
  const lobeOf = (m) => {
    if (!lobe) return 0;
    const count = new Map();
    const step = Math.max(1, Math.floor(m.at.length / 9));
    for (let k = 0; k < m.at.length; k += step) {
      const i = m.at[k];
      const x = i % w;
      const v = lobe[((i - x) / w - b.y0) * (b.x1 - b.x0 + 1) + (x - b.x0)];
      if (v) count.set(v, (count.get(v) || 0) + 1);
    }
    let best = 0;
    for (const [v, n] of count) if (!best || n > count.get(best)) best = v;
    return best;
  };
  const ours = (m) => {
    if (!b.label) return true;
    if (lobe) return lobeOf(m) > 0; // inside the bubble's outline (its paper may be broken up by tone showing through)
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
  // (On the open page only marks of about a letter's height count: specks of tone or hatching, between
  // them, would join everything up. The dots and commas are still read, from the picture.)
  const letters = marks.filter((m) => letterLike(m) && ours(m) && (b.label || m.y1 - m.y0 + 1 >= (lh || 12) * 0.45));
  // Long strokes inside (an outline running into a joined bubble): letters on either side don't group across them.
  const wall = new Set();
  // (Long and thin: letters of two lines touching make a big mark too, but not a line.)
  for (const m of marks) {
    const mw = m.x1 - m.x0 + 1;
    const mh = m.y1 - m.y0 + 1;
    if (!letterLike(m) && Math.max(mw, mh) > size * 4 && m.n < mw * mh * 0.2) for (const i of m.at) wall.add(i);
  }
  // With (in a bubble) only its own paper between them: the lobes of a bubble keep their own words.
  const clear = (p, q) => {
    if (!b.label) return true;
    const ax = (p.x0 + p.x1) / 2;
    const ay = (p.y0 + p.y1) / 2;
    const bx = (q.x0 + q.x1) / 2;
    const by = (q.y0 + q.y1) / 2;
    const steps = Math.max(10, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let t = 1; t < steps; t++) {
      const x = Math.round(ax + ((bx - ax) * t) / steps);
      const y = Math.round(ay + ((by - ay) * t) / steps);
      if (wall.has(y * w + x)) return false; // a line of the drawing between
      const v = b.label[y * w + x];
      if (v && v !== b.id && !(b.sizes && b.sizes[v] < size * size * 1.5)) return false; // another light area lies between (not the inside of a letter)
      if (!v && gray[y * w + x] >= LIGHT && !inside(x, y)) return false; // outside this bubble
    }
    return true;
  };
  const lobes = letters.map(lobeOf);
  const joined = (items, near) => {
    const up = items.map((_, k) => k);
    const root = (k) => {
      while (up[k] !== k) k = up[k] = up[up[k]];
      return k;
    };
    for (let a = 0; a < items.length; a++) {
      for (let c = a + 1; c < items.length; c++) {
        const ra = root(a);
        const rc = root(c);
        if (ra !== rc && near(items[a], items[c])) up[ra] = rc;
      }
    }
    const out = new Map();
    items.forEach((it, k) => {
      const r = root(k);
      if (!out.has(r)) out.set(r, []);
      out.get(r).push(it);
    });
    return [...out.values()];
  };
  const boxOf = (ms) => ({ x0: Math.min(...ms.map((m) => m.x0)), y0: Math.min(...ms.map((m) => m.y0)), x1: Math.max(...ms.map((m) => m.x1)), y1: Math.max(...ms.map((m) => m.y1)), ms, lobe: ms[0].lobe });
  letters.forEach((m, k) => (m.lobe = lobes[k]));
  // Lines: marks side by side, at the same height, a word space or less apart (word spaces go by the
  // taller letters: in lower case most marks are short).
  const tall = (() => {
    const hs = letters.map((m) => m.y1 - m.y0 + 1).sort((p, q) => p - q);
    return hs.length ? Math.max(size, hs[Math.floor(hs.length * 0.75)]) : size;
  })();
  const lines = joined(letters, (p, q) => {
    if (p.lobe !== q.lobe) return false;
    const over = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
    const cy = Math.abs((p.y0 + p.y1) / 2 - (q.y0 + q.y1) / 2);
    if (over < Math.min(p.y1 - p.y0, q.y1 - q.y0) * 0.4 && cy > size * 0.5) return false;
    const gap = Math.max(p.x0, q.x0) - Math.min(p.x1, q.x1);
    return gap <= tall * 0.9 && clear(p, q);
  }).map(boxOf);
  // Blocks: lines one under another (a line's space apart), overlapping sideways. Two remarks
  // side by side in a bubble, or a box beside a bubble, stay apart.
  const blocks = joined(lines, (p, q) => {
    if (p.lobe !== q.lobe) return false;
    const gapY = Math.max(p.y0, q.y0) - Math.min(p.y1, q.y1);
    if (gapY > tall * 1.1 || gapY < -tall * 0.3) return false;
    const over = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
    const narrow = Math.min(p.x1 - p.x0, q.x1 - q.x0);
    return over >= narrow * 0.25 && clear(p, q);
  });
  // In a bubble, a lobe's letters are one remark; only two stacks of lines side by side, with a
  // clear gap between them all the way down, are two.
  const byRoot = new Map();
  if (lobe) {
    letters.forEach((m) => {
      if (!byRoot.has(m.lobe)) byRoot.set(m.lobe, []);
      byRoot.get(m.lobe).push(m);
    });
  } else blocks.forEach((bl, k) => byRoot.set(k, [].concat(...bl.map((l) => l.ms))));
  const columns = (ms) => {
    if (!lobe || ms.length < 4) return [ms];
    const sorted = ms.slice().sort((p, q) => p.x0 - q.x0);
    let reach = sorted[0].x1;
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k].x0 - reach >= tall * 0.8) {
        const left = sorted.slice(0, k);
        const right = sorted.slice(k);
        const high = (side) => Math.max(...side.map((m) => m.y1)) - Math.min(...side.map((m) => m.y0));
        if (high(left) >= tall * 1.8 && high(right) >= tall * 1.8) return columns(left).concat(columns(right));
      }
      reach = Math.max(reach, sorted[k].x1);
    }
    return [ms];
  };
  const groups = [];
  for (const ms of byRoot.values()) {
    for (const col of columns(ms)) {
      const g = { x0: col[0].x0, y0: col[0].y0, x1: col[0].x1, y1: col[0].y1, marks: col.length, at: [], ms: col };
      for (const m of col) {
        g.x0 = Math.min(g.x0, m.x0);
        g.y0 = Math.min(g.y0, m.y0);
        g.x1 = Math.max(g.x1, m.x1);
        g.y1 = Math.max(g.y1, m.y1);
        for (const k of m.at) g.at.push(k);
      }
      // Letters are alike in size: a group of odd marks (hair, a pattern) isn't lettering.
      const hs = col.map((m) => m.y1 - m.y0 + 1).sort((p, q) => p - q);
      const mid = hs[hs.length >> 1];
      g.even = hs.filter((x) => x >= mid * 0.55 && x <= mid * 1.6).length / hs.length;
      g.letterSize = mid;
      groups.push(g);
    }
  }
  return groups.filter((g) => g.marks >= 2).sort((p, q) => q.marks - p.marks);
}

/**
 * Words outside the bubbles found: groups of letters on light paper (a bubble
 * whose outline runs into the panel's edge, lettering on the page). Groups in
 * a found bubble, on tone or art, or too long for words are left out.
 */
function looseGroups(gray, w, h, bubbles, lh, paper = 0.6) {
  const page = { x0: 0, y0: 0, x1: w - 1, y1: h - 1, rows: null };
  const label = bubbles.length ? bubbles[0].label : null;
  const taken = new Set(bubbles.map((b) => b.id));
  const out = [];
  for (const g of letterGroups(gray, w, page, lh)) {
    if (g.marks < 3 || g.even < 0.7 || g.letterSize < lh * 0.5 || g.letterSize > lh * 1.8) continue;
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
    if (light < all * paper || inBubble > all * 0.15) continue;
    out.push(within(page, g, m, w)); // (just its letters: the art around isn't read)
  }
  return out;
}

/** The part of region b (a picture w wide) inside group g's box (grown by `pad`), keeping only g's letters. */
/**
 * A single line of lettering, tilted or with stray marks beside it (pieces of a jagged outline,
 * speed lines): the line through its letters' middles, found again without marks well off it.
 * Returns { angle (radians, 0 when nearly level), size, off(mark), stray (marks left out) }, or null.
 */
function lineFit(g) {
  const ms = g.ms || [];
  if (ms.length < 3) return null;
  const hs = ms.map((m) => m.y1 - m.y0 + 1).sort((p, q) => p - q);
  const mid = hs[hs.length >> 1];
  const all = ms.filter((m) => m.y1 - m.y0 + 1 >= mid * 0.6);
  let big = all;
  for (let round = 0; round < 4 && big.length >= 2; round++) { // (two letters are enough for "Uh...")
    const xs = big.map((m) => (m.x0 + m.x1) / 2);
    const ys = big.map((m) => (m.y0 + m.y1) / 2);
    const n = xs.length;
    const mx = xs.reduce((s, x) => s + x, 0) / n;
    const my = ys.reduce((s, y) => s + y, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) (sxx += (xs[i] - mx) ** 2), (sxy += (xs[i] - mx) * (ys[i] - my));
    if (!sxx) return null;
    const k = sxy / sxx;
    const off = (m) => Math.abs((m.y0 + m.y1) / 2 - (my + k * ((m.x0 + m.x1) / 2 - mx)));
    const worst = big.reduce((p, q) => (off(q) > off(p) ? q : p));
    if (off(worst) <= mid * 0.6) {
      if (big.length < all.length * 0.6) return null; // several lines, not one
      const angle = Math.atan(k);
      if (Math.abs(angle) > 0.7) return null;
      return { angle: Math.abs(angle) > 0.05 ? angle : 0, size: mid, off, stray: ms.filter((m) => off(m) > mid * 0.75).length };
    }
    big = big.filter((m) => m !== worst);
  }
  return null;
}

function within(b, g, pad, w) {
  const x0 = Math.max(b.x0, g.x0 - pad);
  const x1 = Math.min(b.x1, g.x1 + pad);
  const y0 = Math.max(b.y0, g.y0 - pad);
  const y1 = Math.min(b.y1, g.y1 + pad);
  // (The whole box: a letter close to the outline can reach past the bubble's paper; `keep` limits it to the letters.)
  const rows = [];
  for (let y = y0; y <= y1; y++) rows.push([x0, x1]);
  // Only the group's own letters (and a little around them, for thin strokes) are read: no art or outline between lobes.
  const bw = x1 - x0 + 1;
  const keep = new Uint8Array(bw * (y1 - y0 + 1));
  const r = Math.max(2, Math.round(pad * 0.25)); // (a little round each letter, for its thin strokes)
  const mark = (into, pixels) => {
    for (const i of pixels) {
      const gx = i % w;
      const gy = (i - gx) / w;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = gx + dx - x0;
          const yy = gy + dy - y0;
          if (xx >= 0 && yy >= 0 && xx < bw && yy <= y1 - y0) into[yy * bw + xx] = 1;
        }
      }
    }
  };
  mark(keep, g.at);
  const part = { x0, y0, x1, y1, rows, part: true, keep };
  // A tilted line, or one with stray marks beside it: another way to read it, set level, strays left out
  // (tried when the plain reading is unsure).
  const fit = lineFit(g);
  if (fit && (fit.angle || fit.stray)) {
    const only = new Uint8Array(keep.length);
    mark(only, [].concat(...g.ms.filter((m) => fit.off(m) <= fit.size * 0.75).map((m) => m.at)));
    part.alt = { x0, y0, x1, y1, rows, part: true, keep: only, angle: fit.angle };
  }
  return part;
}

// Short things said, that count as words on their own.
const SHORT = new Set('oh uh ah eh no go so um hm mm ok hi ha ow yo me we us he it is in on to do my by up i a o'.split(' '));

/**
 * Is what was read like words? Pictures read as letters come out as runs of
 * short scraps, digits and signs the engine wasn't sure of ("6 0 0 0 8", "™ v").
 */
export function wordLike(r, lang) {
  const words = [];
  for (const l of r.lines) for (const w of l.words) words.push(w);
  if (!words.length) return false;
  // A short sound in a bubble, its letters alone and set level ("Uh...", "Hmm?"): the engine is
  // seldom sure of so few letters, but a sound people make is enough.
  if (r.levelled && lang === 'en') {
    const bare = words.map((w) => w.text.replace(/[^A-Za-z]/g, '').toLowerCase()).filter(Boolean);
    if (bare.length && bare.length <= 2 && bare.every((t) => t.length >= 2 && (said(t) || SHORT.has(t))) && r.confidence >= 8) return true;
  }
  // Stacked letters read as a word: the engine is seldom sure of them, but a real word or a sound is enough.
  if (r.stacked && lang === 'en') {
    const bare = r.text.replace(/[^A-Za-z]/g, '').toLowerCase();
    return bare.length >= 2 && (said(bare) || (dict && dict.has(bare)));
  }
  const text = words.map((w) => w.text).join(' ');
  const letters = text.replace(/[^\p{L}]/gu, '').length;
  const signs = text.replace(/[\p{L}\p{N}\s.,!?…'’"“”\-–—~()]/gu, '').length;
  const digits = text.replace(/[^\p{N}]/gu, '').length;
  if (letters < 2 || signs > Math.max(1, letters * 0.15)) return false;
  if (digits > letters) return false;
  const sure = words.filter((w) => (w.conf == null ? 100 : w.conf) >= (said(w.text.replace(/[^A-Za-z]/g, '').toLowerCase()) ? 30 : 60)).length; // (drawn-out sounds read less surely)
  if (r.confidence < 50 || sure < words.length * 0.5) return false;
  if (lang === 'en') {
    // Real lettering has words of several letters, with vowels.
    const real = words.filter((w) => (/[A-Za-z]{2,}/.test(w.text) && /[aeiouyAEIOUY]/.test(w.text)) || said(w.text.replace(/[^A-Za-z]/g, '').toLowerCase())).length;
    const one = words.filter((w) => /^[IAaOo][.,!?…'’]*$/.test(w.text)).length;
    if (real + one < Math.max(1, words.length * 0.5)) return false;
    // Only short scraps ("AT", "Si AY"): a word of three letters or more, or one of the short
    // things people say ("Oh...", "Go!", "Uh...").
    const bare = words.map((w) => w.text.replace(/[^A-Za-z]/g, '').toLowerCase()).filter(Boolean);
    if (!bare.some((t) => t.length >= 3) && !bare.every((t) => SHORT.has(t) || said(t))) return false;
    if (digits * 2 >= letters) return false;
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
    if (debug.trace) debug.trace.push({ bubble: [b.x0, b.y0, b.x1, b.y1].map((v) => v / a.k), lh: lh / a.k, groups: groups.map((g) => [g.x0, g.y0, g.x1, g.y1].map((v) => v / a.k)), fits: groups.map((g) => { const f = lineFit(g); return f ? [+f.angle.toFixed(2), f.stray, g.ms.length] : g.ms && g.ms.length; }) });
    if (!groups.length) return []; // no letters in it (a face, the sky)
    if (groups.length > 1) {
      const pad = Math.max(3, Math.round((lh || 12) * 0.8));
      const out = [];
      for (const g of groups) out.push(await lineByLine(img, a, sx, b, g, lang, await readGroup(img, a, sx, b, g, pad, lang)));
      return out;
    }
    if (groups.length === 1 && stacked(groups[0])) return [await readGroup(img, a, sx, b, groups[0], 0, lang)];
    // One group: the whole bubble is read; its letters alone, set level, as another try.
    if (groups.length === 1) {
      const alt = within(b, groups[0], Math.max(3, Math.round(groups[0].letterSize * 0.8)), a.w).alt;
      const r = await readBest(img, a, sx, alt ? Object.assign({}, b, { alt }) : b, lang);
      return [await lineByLine(img, a, sx, b, groups[0], lang, r)];
    }
  }
  return [await readBest(img, a, sx, b, lang)];
}

/**
 * The engine sometimes leaves a line out (a big shout above smaller words): when a reading has far
 * fewer letters than the group has marks, its lines are read one by one, and that kept if better.
 */
async function lineByLine(img, a, sx, b, g, lang, r) {
  const marks = (g.ms || []).filter((m) => m.y1 - m.y0 + 1 >= g.letterSize * 0.6).length;
  const letters = r.text.replace(/[^A-Za-z]/g, '').length;
  if (lang !== 'en' || !g.ms || marks < 6) return r;
  // Rows: marks overlapping in height.
  const rows = [];
  for (const m of g.ms.slice().sort((p, q) => p.y0 - q.y0)) {
    const row = rows.find((w) => Math.min(w.y1, m.y1) - Math.max(w.y0, m.y0) > Math.min(w.y1 - w.y0, m.y1 - m.y0) * 0.4);
    if (row) Object.assign(row, { y0: Math.min(row.y0, m.y0), y1: Math.max(row.y1, m.y1) }).ms.push(m);
    else rows.push({ y0: m.y0, y1: m.y1, ms: [m] });
  }
  // (Rows of real letters, not a dot or a stray mark: a reading with as many lines is complete.)
  const real = rows.filter((w) => w.ms.some((m) => m.y1 - m.y0 + 1 >= g.letterSize * 0.6));
  if (real.length < 2 || real.length > 8 || (r.lines.length >= real.length && letters >= marks * 0.6)) return r;
  const lines = [];
  for (const row of rows.sort((p, q) => p.y0 - q.y0)) {
    const ms = row.ms;
    const rg = { x0: Math.min(...ms.map((m) => m.x0)), y0: row.y0, x1: Math.max(...ms.map((m) => m.x1)), y1: row.y1, at: [].concat(...ms.map((m) => m.at)), ms, letterSize: g.letterSize };
    const one = await readRegion(img, a, sx, within(b, rg, Math.max(3, Math.round(g.letterSize * 0.6)), a.w), lang, 40, '7');
    for (const l of one.lines) lines.push(l);
  }
  if (!lines.length) return r;
  const text = lines.map((l) => l.words.map((w) => w.text).join(' ')).join(' ').replace(/(\w)- (\w)/g, '$1$2').trim();
  const all = lines.reduce((n, l) => n.concat(l.words), []);
  const each = { lines, text, box: r.box, confidence: all.reduce((n, w) => n + w.conf, 0) / all.length };
  if (debug.trace) debug.trace.push({ box: [r.box.x, r.box.y, r.box.x + r.box.w, r.box.y + r.box.h], byLine: [r.text, each.text, wordLike(each, lang), Math.round(each.confidence), marks] });
  return wordLike(each, lang) && each.text.replace(/[^A-Za-z]/g, '').length > letters * 1.3 ? each : r;
}

/** Read a group of letters: letters stacked one under another as one word, else as usual. */
async function readGroup(img, a, sx, b, g, pad, lang) {
  const glyphs = stacked(g);
  if (glyphs) {
    const v = await readStack(img, a, sx, g, glyphs, lang);
    if (v) return v;
  }
  return readBest(img, a, sx, within(b, g, pad || Math.max(3, Math.round(g.letterSize * 0.8)), a.w), lang);
}

/**
 * Letters written one under another ("W / H / O / A / !"): the group's marks, top to bottom, as
 * letters (an "!" or "?" is two marks: its dot goes with it). Returns the letters' boxes, or null
 * when the group isn't like that.
 */
function stacked(g) {
  const ms = (g.ms || []).slice().sort((p, q) => p.y0 - q.y0);
  if (ms.length < 3) return null;
  const hs = ms.map((m) => m.y1 - m.y0 + 1).sort((p, q) => p - q);
  const mid = hs[hs.length >> 1];
  const glyphs = [];
  for (const m of ms) {
    const last = glyphs[glyphs.length - 1];
    const small = m.y1 - m.y0 + 1 < mid * 0.45;
    // A dot (of "!", "?", "i") just under or over the mark before: the same letter.
    if (last && small && m.y0 - last.y1 < mid * 0.5 && Math.min(m.x1, last.x1) - Math.max(m.x0, last.x0) > -mid * 0.2) {
      Object.assign(last, { x0: Math.min(last.x0, m.x0), x1: Math.max(last.x1, m.x1), y1: Math.max(last.y1, m.y1) });
      continue;
    }
    glyphs.push({ x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1 });
  }
  if (glyphs.length < 3) return null;
  // One letter to a line: each below the one before (hardly overlapping), in a column.
  const cx = glyphs.map((q) => (q.x0 + q.x1) / 2).sort((p, q) => p - q)[glyphs.length >> 1];
  const width = Math.max(...glyphs.map((q) => q.x1 - q.x0 + 1));
  for (let i = 0; i < glyphs.length; i++) {
    const q = glyphs[i];
    if (Math.abs((q.x0 + q.x1) / 2 - cx) > Math.max(width, mid) * 0.8) return null;
    if (i && q.y0 < glyphs[i - 1].y1 - mid * 0.25) return null; // side by side: a line of letters
  }
  if (width > mid * 2.2) return null; // a word per line, not a letter
  return glyphs;
}

/** Read stacked letters: set side by side, as a line, and read as one word. */
async function readStack(img, a, sx, g, glyphs, lang) {
  const k = a.k;
  const H = 48;
  const pics = glyphs.map((q) => {
    const x = sx + q.x0 / k;
    const y = q.y0 / k;
    const w = (q.x1 - q.x0 + 1) / k;
    const h = (q.y1 - q.y0 + 1) / k;
    return { x, y, w, h };
  });
  const tallest = Math.max(...pics.map((q) => q.h));
  const s = H / tallest;
  const gap = Math.round(H * 0.18);
  const pad = 24;
  const cw = Math.round(pics.reduce((n, q) => n + q.w * s + gap, pad * 2));
  const ch = Math.round(H + pad * 2);
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingQuality = 'high';
  let x = pad;
  for (const q of pics) {
    // Letters sit on one baseline (small ones, like a dot, at the bottom).
    ctx.drawImage(img, q.x, q.y, q.w, q.h, x, pad + H - q.h * s, q.w * s, q.h * s);
    x += q.w * s + gap;
  }
  const d = ctx.getImageData(0, 0, cw, ch);
  const px = d.data;
  const hist = new Uint32Array(256);
  for (let j = 0; j < px.length; j += 4) hist[(px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000 | 0]++;
  const t = otsu(hist, px.length / 4);
  for (let j = 0; j < px.length; j += 4) {
    const v = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000 <= t ? 0 : 255;
    px[j] = px[j + 1] = px[j + 2] = v;
  }
  ctx.putImageData(d, 0, 0);
  const worker = await workerFor(lang);
  await worker.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '0', user_defined_dpi: '300', tessedit_char_blacklist: '|{}[]<>@#$%^&*_=+~`\\' });
  const { data } = await timed('stack', worker.recognize(c, {}, { text: true, blocks: true }));
  const image = debug.images ? c.toDataURL() : undefined;
  c.width = c.height = 0;
  const text = (data.text || '').replace(/\s+/g, '').trim();
  if (!text) return null;
  const box = { x: sx + g.x0 / k, y: g.y0 / k, w: (g.x1 - g.x0 + 1) / k, h: (g.y1 - g.y0 + 1) / k };
  const words = [{ text, conf: data.confidence || 0, x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h }];
  const lines = [{ words }];
  tidyWords(lines, lang);
  if (!lines.length) return null;
  return { lines, text: lines[0].words.map((w) => w.text).join(' '), box, confidence: data.confidence || 0, image, stacked: true };
}

/**
 * Read a region at the usual letter size; when the engine isn't sure of some
 * of it, again with bigger letters (lettering styles differ in which reads
 * better), keeping the better reading.
 */
async function readBest(img, a, sx, b, lang) {
  const first = await readRegion(img, a, sx, b, lang, 34);
  const words = first.lines.reduce((n, l) => n.concat(l.words), []);
  if (lang !== 'en' || (first.confidence >= 85 && words.every((w) => w.conf >= 70))) return first;
  const tries = [first];
  // A tilted line (a shout), or one with bits of outline beside it: set level, just its letters.
  if (b.alt) {
    for (const r of [await readRegion(img, a, sx, b.alt, lang, 34), await readRegion(img, a, sx, b.alt, lang, 50, '7')]) tries.push(Object.assign(r, { levelled: true }));
  }
  // (Nothing like words at all: a picture, not worth a second look.)
  const hopeless = !words.length || first.confidence < 40 || first.text.replace(/[^A-Za-z]/g, '').length < 2;
  if (!hopeless) {
    // Bigger letters; and a line or two read as one line, which suits short exclamations.
    tries.push(await readRegion(img, a, sx, b, lang, 50));
    if (first.lines.length <= 2) tries.push(await readRegion(img, a, sx, b, lang, 50, '7'));
  }
  if (tries.length === 1) return first;
  // (A reading that leaves words out isn't better for being sure of the rest.)
  // (Compared among readings that look like words: a page of scraps has more letters, not more words.)
  const most = Math.max(...tries.filter((r) => wordLike(r, lang)).map((r) => r.text.replace(/[^A-Za-z]/g, '').length), 1);
  const score = (r) => readingScore(r, lang) * Math.min(1, r.text.replace(/[^A-Za-z]/g, '').length / most);
  const pick = tries.reduce((p, q) => (score(q) > score(p) ? q : p));
  if (debug.trace) debug.trace.push({ tries: tries.map((r) => [r.text, Math.round(r.confidence), Math.round(score(r)), wordLike(r, lang), r.lines.map((l) => l.words.map((w) => Math.round(w.conf)).join(',')).join('/')]), box: [first.box.x, first.box.y, first.box.x + first.box.w, first.box.y + first.box.h] });
  return pick;
}

/** How good a reading looks: like words, and sure of words that are English (or said aloud). */
function readingScore(r, lang) {
  const words = r.lines.reduce((n, l) => n.concat(l.words), []);
  if (!words.length) return 0;
  const sure = words.reduce((n, w) => {
    const bare = w.text.replace(/[^A-Za-z]/g, '').toLowerCase();
    const known = !bare || !dict || dict.has(bare) || SHORT.has(bare) || said(bare);
    return n + (w.conf == null ? 50 : w.conf) * (known ? 1 : 0.75);
  }, 0);
  return (wordLike(r, lang) ? 100 : 0) + sure / words.length;
}

/** A sound people make, letters drawn out: "Waaaah", "Ahhh", "Hmmm", "Eek", "Eyyyaah". */
export function said(bare) {
  return /^(?:w+a+h*|a+h+|o+h+|u+h+|e+h+|h+m+|m+|u+m+|e+e+k+|g+a+h+|n+o+|y+a+y+|e*y+a+h*|e+y+|a+w+|o+w+|w+o+w+|h+u+h+|w+h+o+a+)$/.test(bare);
}

/**
 * Read one region (a bubble with its row spans, or a plain box). Positions
 * come back in picture pixels: { lines: [{ words: [{ text, x0, y0, x1, y1 }] }], text, confidence }.
 */
async function readRegion(img, a, sx, b, lang, letterPx = 34, psm = lang === 'ja-v' ? '5' : '6') {
  const k = a.k;
  // The outline is left out: the mask is drawn in from the edge by a few per cent.
  const inset = b.rows && !b.part ? Math.max(2, Math.round(Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.05)) : 0;
  const box = { x: sx + b.x0 / k, y: b.y0 / k, w: (b.x1 - b.x0 + 1) / k, h: (b.y1 - b.y0 + 1) / k };
  // Letters about 34 px tall are what the engine usually reads best.
  const lh = letterHeight(a.g, a.w, b) / k;
  const scale = lh > 0 ? Math.max(0.6, Math.min(4, letterPx / lh)) : Math.max(1, Math.min(4, 1100 / Math.max(box.w, box.h)));
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
      let v = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
      if (b.invert) v = 255 - v; // light letters on a dark ground
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
  // Tilted lettering is set level first (the engine reads level lines).
  let page = c;
  const angle = b.angle || 0;
  if (angle) {
    page = document.createElement('canvas');
    page.width = cw;
    page.height = ch;
    const t2 = page.getContext('2d');
    t2.fillStyle = '#fff';
    t2.fillRect(0, 0, cw, ch);
    t2.translate(cw / 2, ch / 2);
    t2.rotate(-angle);
    t2.drawImage(c, -cw / 2, -ch / 2);
  }
  const worker = await workerFor(lang);
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
    tessedit_char_blacklist: lang === 'en' ? '|{}[]<>@#$%^&*_=+~`\\' : '',
  });
  const { data } = await timed('region', worker.recognize(page, {}, { text: true, blocks: true }));
  const image = debug.images ? page.toDataURL() : undefined;
  c.width = c.height = 0;
  page.width = page.height = 0;
  // (From the levelled picture back: a word's middle turned back, its size kept.)
  const back = (bb) => {
    let cx = (bb.x0 + bb.x1) / 2;
    let cy = (bb.y0 + bb.y1) / 2;
    if (angle) {
      const dx = cx - cw / 2;
      const dy = cy - ch / 2;
      cx = cw / 2 + dx * Math.cos(angle) - dy * Math.sin(angle);
      cy = ch / 2 + dx * Math.sin(angle) + dy * Math.cos(angle);
    }
    const hw = (bb.x1 - bb.x0) / 2;
    const hh = (bb.y1 - bb.y0) / 2;
    return { x0: box.x + (cx - hw - pad) / scale, y0: box.y + (cy - hh - pad) / scale, x1: box.x + (cx + hw - pad) / scale, y1: box.y + (cy + hh - pad) / scale };
  };
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
  // Scraps the engine had no faith in, beside words it read surely (a piece of the art, of the next
  // bubble), are dropped; the reading's confidence is then the remaining words'.
  let confidence = data.confidence || 0;
  if (lang === 'en' && lines.some((l) => l.words.some((w) => w.conf >= 70))) {
    let dropped = false;
    for (const l of lines) {
      const keep = l.words.filter((w) => { const t = w.text.replace(/[^A-Za-z]/g, '').toLowerCase(); return w.conf >= 25 || (w.conf >= 8 && (said(t) || /^[ia]$/.test(t))); }); // (a shout is often read unsurely)
      if (keep.length < l.words.length) (dropped = true), (l.words = keep);
    }
    for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].words.length) lines.splice(i, 1);
    if (dropped) {
      const all = lines.reduce((n, l) => n.concat(l.words), []);
      confidence = all.reduce((n, w) => n + w.conf, 0) / Math.max(1, all.length);
    }
  }
  tidyWords(lines, lang);
  const text = lines.map((l) => l.words.map((w) => w.text).join(lang === 'en' ? ' ' : '')).join(lang === 'en' ? ' ' : '');
  return { lines, text: text.replace(/(\w)- (\w)/g, '$1$2').trim(), box, confidence, image };
}

// ---------------------------------------------------------------- the dictionary

// English words, commonest first (SCOWL, see words-en-COPYRIGHT.txt), letters only: word → rank.
let dict = null;
const SAID = 'dont youre im ive id isnt cant wont didnt doesnt its thats whats theres lets shes hes theyre weve youve wasnt arent werent couldnt wouldnt shouldnt havent hasnt hadnt youll shell theyll wed youd hed theyd whos wheres hows aint yall hmm huh eek uh um oh ah ugh mmm sec okay ok'.split(' ');

async function loadDictionary() {
  if (dict) return dict;
  try {
    const text = await (await fetch(BASE + 'words-en.txt')).text();
    const m = new Map();
    text.split('\n').forEach((w, i) => w && !m.has(w) && m.set(w, i));
    for (const w of SAID) if (!m.has(w)) m.set(w, 0);
    dict = m;
  } catch (e) {
    dict = null; // (read without it)
  }
  return dict;
}

// What the engine takes for what, in comic lettering.
// (Only shapes that really look alike: a name such as "Roxy" mustn't become "foxy".)
const CONFUSED = [['c', 'e'], ['e', 'c'], ['1', 'l'], ['1', 'i'], ['l', 'i'], ['i', 'l'], ['0', 'o'], ['rn', 'm'], ['m', 'rn'], ['vv', 'w'], ['ii', 'u'], ['cl', 'd'], ['li', 'h'], ['5', 's'], ['8', 'b']];

/** A word as read, put right if it isn't a word and a likely confusion of a common one is. */
export function fixWord(text) {
  const m = /^([^A-Za-z0-9]*)([A-Za-z0-9]+)([^A-Za-z0-9]*)$/.exec(text);
  if (!m || !dict) return text;
  const core = m[2];
  const key = core.toLowerCase();
  // Two letters: only an e read as c ("mc", "wc", "bc").
  if (key.length === 2 && /c$/.test(key) && !SHORT.has(key) && dict.get(key[0] + 'e') < 300) return m[1] + core[0] + (core[1] === 'C' ? 'E' : 'e') + m[3];
  if (key.length < 3 || dict.has(key) || said(key) || /^\d+$/.test(key)) return text;
  let best = null;
  let rank = Infinity;
  const tryWord = (cand) => {
    const r = dict.get(cand);
    if (r != null && r < rank && !/\d/.test(cand)) (best = cand), (rank = r);
  };
  const once = (word, f) => {
    for (const [a, b] of CONFUSED) {
      for (let i = word.indexOf(a); i >= 0; i = word.indexOf(a, i + 1)) f(word.slice(0, i) + b + word.slice(i + a.length));
    }
  };
  once(key, (c1) => {
    tryWord(c1);
    if (key.length >= 4) once(c1, tryWord); // (two confusions in a longer word)
  });
  // A stray mark read as a thin letter at either end ("ithe", "you1").
  if (!best && key.length >= 4) {
    if (/^[il1]/.test(key)) tryWord(key.slice(1));
    if (/[il1]$/.test(key)) tryWord(key.slice(0, -1));
  }
  if (!best) return text;
  const cased = core === core.toUpperCase() ? best.toUpperCase() : /^[A-Z]/.test(core) ? best[0].toUpperCase() + best.slice(1) : best;
  return m[1] + cased + m[3];
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
      t = t.replace(/^1(?=[a-z]{1,3}\b)/, 'i').replace(/^1(?=[A-Z]{1,3}\b)/, 'I').replace(/([A-Za-z])0(?=[A-Za-z])/g, '$1o').replace(/([A-Za-z])1(?=[A-Za-z])/g, '$1l').replace(/([A-Za-z])5(?=[A-Za-z])/g, '$1s').replace(/([A-Za-z])4+(?=[A-Za-z])/g, (m, c) => c + 'a'.repeat(m.length - 1));
    } else if (/^[17]([.,!?…'’"”]*)$/.test(t) && numbers <= 1 && all.length > 2) {
      t = 'I' + t.slice(1);
    }
    w.text = t;
  }
  // Letters the engine confuses ("lcaving", "mcct", "WISC"): a word not in the dictionary becomes the
  // commonest one a confusion or two away, if there is one (names, which aren't in it, stay).
  if (dict) for (const w of all) w.text = fixWord(w.text);
  // A narrow "I" glued to the next word ("ILEFT"): split off when the rest is a common word.
  for (const w of all) {
    const m = /^I([A-Za-z]+)([^A-Za-z]*)$/.exec(w.text);
    if (m && m[1].length > 1 && FOLLOWS_I.has(m[1].toLowerCase()) && !FOLLOWS_I.has(w.text.toLowerCase())) w.text = `I ${m[1]}${m[2]}`;
  }
  // Stray marks read as words: a lone dash, a scrap with a dash at the very end ("y-").
  for (const l of lines) l.words = l.words.filter((w) => !/^[-–—~]+$/.test(w.text));
  const tail = lines.length && lines[lines.length - 1].words;
  if (tail && tail.length > 1 && /^[A-Za-z]{1,2}-$/.test(tail[tail.length - 1].text)) tail.pop();
  for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].words.length) lines.splice(i, 1);
  all.length = 0;
  for (const l of lines) for (const w of l.words) all.push(w);
  // Comic capitals become ordinary sentences (nearly all capitals: a misread letter or two is lower case).
  const letters = all.map((w) => w.text).join('').replace(/[^A-Za-z]/g, '');
  const upper = letters.replace(/[^A-Z]/g, '').length;
  if (letters.length > 3 && upper >= letters.length * 0.8) {
    let start = true;
    let joined = false; // (the rest of a word broken across lines with a hyphen)
    for (const w of all) {
      let t = w.text.toLowerCase();
      if (/^i(['’](m|ll|ve|d))?[^a-z]*$/.test(t)) t = 'I' + t.slice(1);
      // (A name, not in the dictionary, keeps its capital: "Roxy".)
      const bare = t.replace(/[^a-z]/g, '');
      if (!joined && (start || (dict && bare.length >= 3 && !dict.has(bare) && /^[a-z]/.test(t.replace(/^[^a-z]+/, ''))))) t = t.replace(/[a-z]/, (c) => c.toUpperCase());
      joined = /[a-z]-$/.test(t);
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
    if (lang === 'en') await loadDictionary();
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
export function readPage(img, { sx = 0, sw = img.naturalWidth || img.width, lang = 'en', rtl = false, rejected = null }, onProgress = () => {}) {
  return queued(async () => {
    if (lang === 'en') await loadDictionary();
    const ih = img.naturalHeight || img.height;
    const a = grayOf(img, sx, 0, sw, ih);
    const found = findBubbles(a.g, a.w, a.h);
    if (lang === 'en') {
      // Lettering outside them, about the size of the bubbles' own.
      const sizes = found.map((b) => letterHeight(a.g, a.w, b)).filter(Boolean).sort((p, q) => p - q);
      const lh = sizes.length ? sizes[sizes.length >> 1] : 12;
      const loose = looseGroups(a.g, a.w, a.h, found, lh);
      // And light lettering on dark (a caption on a black panel): the same, the picture inverted.
      const inv = new Uint8Array(a.g.length);
      for (let i = 0; i < inv.length; i++) inv[i] = 255 - a.g[i];
      for (const g of looseGroups(inv, a.w, a.h, found, lh, 0.45)) loose.push(Object.assign(g, { invert: true })); // (dark grounds are often hatched)
      found.push(...loose);
    }
    const out = [];
    for (let i = 0; i < found.length; i++) {
      onProgress(i, found.length);
      for (const r of await readBubble(img, a, sx, found[i], lang)) {
        if (lang === 'en' ? wordLike(r, lang) : r.text.replace(/[^\p{L}]/gu, '').length >= 2 && r.confidence >= 45) out.push(r);
        else if (rejected) rejected.push(r); // (for testing: what was read and left out)
      }
    }
    // Words on the art itself (narration over a picture, lettering on tone): the engine's own search
    // over the whole page finds where they are; each place found is then read like a bubble.
    if (lang === 'en') {
      const sizes = out.map((r) => r.lines.length && r.lines[0].words.length && r.lines[0].words[0].y1 - r.lines[0].words[0].y0).filter((x) => x > 0).sort((p, q) => p - q);
      const lh = sizes.length ? sizes[sizes.length >> 1] : 40;
      for (const box of await sparseText(img, sx, sw, lh, out.map((r) => r.box))) {
        const k = a.k;
        let b = { x0: Math.max(0, Math.round((box.x - sx) * k)), y0: Math.max(0, Math.round(box.y * k)), x1: Math.min(a.w - 1, Math.round((box.x - sx + box.w) * k)), y1: Math.min(a.h - 1, Math.round((box.y + box.h) * k)), rows: null };
        // The engine was sure of some of the words: the whole block of lettering around them is read
        // (the letters' lines and blocks, found near them).
        const lhA = lh * k;
        const near = { x0: Math.max(0, Math.round(b.x0 - lhA * 4)), y0: Math.max(0, Math.round(b.y0 - lhA * 4)), x1: Math.min(a.w - 1, Math.round(b.x1 + lhA * 4)), y1: Math.min(a.h - 1, Math.round(b.y1 + lhA * 4)), rows: null };
        const mine = letterGroups(a.g, a.w, near, lhA).filter((g) => !(g.x1 < b.x0 || g.x0 > b.x1 || g.y1 < b.y0 || g.y0 > b.y1) && g.even >= 0.6);
        if (mine.length) {
          // Only those letters are read, not the picture around them (tone, clouds).
          const u = { x0: Math.min(...mine.map((g) => g.x0)), y0: Math.min(...mine.map((g) => g.y0)), x1: Math.max(...mine.map((g) => g.x1)), y1: Math.max(...mine.map((g) => g.y1)), at: [].concat(...mine.map((g) => g.at)) };
          b = within({ x0: 0, y0: 0, x1: a.w - 1, y1: a.h - 1, rows: null }, u, Math.max(3, Math.round(lhA * 0.6)), a.w);
        }
        const r = await readBest(img, a, sx, b, lang);
        if (wordLike(r, lang)) out.push(r);
        else if (rejected) rejected.push(r);
      }
    }
    onProgress(found.length, found.length);
    // (The panels too: read aloud, the view keeps the panel of the bubble being read in sight.)
    const panels = findPanels(a.g, a.w, a.h);
    const geo = { sx, sw, ih };
    return Object.assign(inReadingOrder(out, rtl, panels, geo), { panels, geo });
  });
}

/**
 * Where there are words outside the places already read (`taken`, picture
 * pixels): the engine looks over the whole page (sparse text), its surer
 * words are kept and gathered into blocks, given back as boxes to read.
 */
async function sparseText(img, sx, sw, lh, taken) {
  const ih = img.naturalHeight || img.height;
  // (Only finding where words are: smaller letters do, and the engine is much quicker on a smaller page.)
  const scale = Math.max(0.3, Math.min(0.8, 24 / Math.max(8, lh)));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(ih * scale);
  c.getContext('2d').drawImage(img, sx, 0, sw, ih, 0, 0, c.width, c.height);
  const worker = await workerFor('en');
  await worker.setParameters({ tessedit_pageseg_mode: '11', user_defined_dpi: '300', tessedit_char_blacklist: '|{}[]<>@#$%^&*_=+~`\\' });
  const { data } = await timed('sparse', worker.recognize(c, {}, { blocks: true }));
  c.width = c.height = 0;
  const words = [];
  for (const bl of data.blocks || []) {
    for (const p of bl.paragraphs || []) {
      for (const l of p.lines || []) {
        for (const wd of l.words || []) {
          const t = (wd.text || '').trim();
          const letters = t.replace(/[^A-Za-z]/g, '');
          if (wd.confidence < 65 || letters.length < 2 || !/[aeiouyAEIOUY]/.test(letters)) continue;
          const box = { x: sx + wd.bbox.x0 / scale, y: wd.bbox.y0 / scale, w: (wd.bbox.x1 - wd.bbox.x0) / scale, h: (wd.bbox.y1 - wd.bbox.y0) / scale };
          // Not in what was read already.
          const inside = taken.some((q) => {
            const ox = Math.min(box.x + box.w, q.x + q.w) - Math.max(box.x, q.x);
            const oy = Math.min(box.y + box.h, q.y + q.h) - Math.max(box.y, q.y);
            return ox > 0 && oy > 0 && ox * oy > box.w * box.h * 0.3;
          });
          if (!inside && box.h > lh * 0.4 && box.h < lh * 2.5) words.push(Object.assign(box, { conf: wd.confidence, n: letters.length }));
        }
      }
    }
  }
  // Blocks: words on a line, and lines one under another.
  const up = words.map((_, i) => i);
  const root = (i) => {
    while (up[i] !== i) i = up[i] = up[up[i]];
    return i;
  };
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) {
      const p = words[i];
      const q = words[j];
      const hh = Math.max(p.h, q.h);
      const gx = Math.max(p.x, q.x) - Math.min(p.x + p.w, q.x + q.w);
      const gy = Math.max(p.y, q.y) - Math.min(p.y + p.h, q.y + q.h);
      if (gx < hh * 1.2 && gy < hh * 0.9) up[root(i)] = root(j);
    }
  }
  const blocks = new Map();
  words.forEach((wd, i) => {
    const r = root(i);
    if (!blocks.has(r)) blocks.set(r, []);
    blocks.get(r).push(wd);
  });
  const out = [];
  for (const ws of blocks.values()) {
    // A lone word only when the engine is sure of it.
    if (ws.length < 2 && !(ws[0].n >= 3 && ws[0].conf >= 80)) continue;
    const x0 = Math.min(...ws.map((q) => q.x));
    const y0 = Math.min(...ws.map((q) => q.y));
    const x1 = Math.max(...ws.map((q) => q.x + q.w));
    const y1 = Math.max(...ws.map((q) => q.y + q.h));
    const pad = lh * 0.5;
    out.push({ x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad });
  }
  return out;
}

/**
 * Reading order by panels: the panels in order (rows from the top, each row
 * from the right in manga), and the bubbles of each panel in order within
 * it. A bubble is in the panel holding most of it; one in no panel (in the
 * gutter) counts as a panel of its own. panels: shares of the area read
 * (geo: { sx, sw, ih } in picture pixels).
 */
function inPanelOrder(list, rtl, panels, geo) {
  const boxes = panels.map((q) => ({ x: geo.sx + q.x0 * geo.sw, y: q.y0 * geo.ih, w: (q.x1 - q.x0) * geo.sw, h: (q.y1 - q.y0) * geo.ih, items: [] }));
  const free = [];
  for (const it of list) {
    const b = it.box;
    // The panel holding most of it; one reaching out into the gutter belongs to the panel it touches
    // most, or failing that the nearest one close by.
    let best = null;
    let most = 0;
    for (const q of boxes) {
      const ox = Math.min(b.x + b.w, q.x + q.w) - Math.max(b.x, q.x);
      const oy = Math.min(b.y + b.h, q.y + q.h) - Math.max(b.y, q.y);
      if (ox > 0 && oy > 0 && ox * oy > most) (most = ox * oy), (best = q);
    }
    if (!best) {
      let near = Math.max(b.w, b.h) * 0.6;
      for (const q of boxes) {
        const d = Math.max(0, q.x - (b.x + b.w), b.x - (q.x + q.w)) + Math.max(0, q.y - (b.y + b.h), b.y - (q.y + q.h));
        if (d < near) (near = d), (best = q);
      }
    }
    if (best) best.items.push(it);
    else free.push({ x: b.x, y: b.y, w: b.w, h: b.h, items: [it] });
  }
  const all = boxes.filter((q) => q.items.length).concat(free).sort((p, q) => p.y - q.y);
  // Rows: a panel starting above the middle of the first panel of a row is in that row.
  const rows = [];
  for (const q of all) {
    const row = rows.find((r) => q.y < r[0].y + r[0].h * 0.5 && q.y + q.h > r[0].y + r[0].h * 0.3);
    if (row) row.push(q);
    else rows.push([q]);
  }
  const out = [];
  for (const r of rows) {
    r.sort((p, q) => (rtl ? q.x + q.w - (p.x + p.w) : p.x - q.x));
    for (const q of r) out.push(...inReadingOrder(q.items, rtl));
  }
  return out;
}

/**
 * Reading order: bubbles side by side (overlapping in height) form a row; rows
 * from the top; within a row from the left, or from the right in manga.
 */
export function inReadingOrder(list, rtl, panels = null, geo = null) {
  if (panels && panels.length && geo) return inPanelOrder(list, rtl, panels, geo);
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

