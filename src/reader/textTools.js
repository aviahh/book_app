// Hit-testing on PDF.js text layers: find the character under a finger,
// expand to a word, and turn a span-range into text + highlight rectangles.
// Everything works in client (viewport) coordinates.

export function collectSpans(layers) {
  const out = [];
  for (const layer of layers) {
    for (const s of layer.querySelectorAll('span[role="presentation"]')) {
      if (s.firstChild?.nodeType === Node.TEXT_NODE && s.textContent.length) out.push(s);
    }
  }
  return out;
}

const range = document.createRange();

function charRect(span, i) {
  const node = span.firstChild;
  range.setStart(node, i);
  range.setEnd(node, i + 1);
  return range.getBoundingClientRect();
}

function dist(rect, x, y) {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy * 1.6); // lines matter more than columns
}

/**
 * Character position under (x, y).
 * mode 'char'  → the character the point is on (for word lookup)
 * mode 'caret' → the boundary nearest the point (for selections)
 * Returns { index, offset } (index into spans) or null.
 */
export function hitTest(spans, x, y, { mode = 'char', maxDist = 0, rects } = {}) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < spans.length; i++) {
    const r = rects ? rects[i] : spans[i].getBoundingClientRect();
    const d = dist(r, x, y);
    if (d < bestD) {
      bestD = d;
      best = i;
      if (d === 0) break;
    }
  }
  if (best < 0 || bestD > maxDist) return null;
  const span = spans[best];
  const len = span.firstChild.length;
  let ci = 0;
  let cd = Infinity;
  for (let i = 0; i < len; i++) {
    const d = dist(charRect(span, i), x, y);
    if (d < cd) {
      cd = d;
      ci = i;
      if (d === 0) break;
    }
  }
  if (mode === 'caret') {
    const r = charRect(span, ci);
    if (x > (r.left + r.right) / 2) ci++;
  }
  return { index: best, offset: ci };
}

const WORD = /[\p{L}\p{N}\p{M}'’\-]/u;

export function wordAt(spans, pos) {
  const text = spans[pos.index].textContent;
  let s = pos.offset;
  let e = pos.offset;
  if (!WORD.test(text[s] || '')) return null;
  while (s > 0 && WORD.test(text[s - 1])) s--;
  while (e < text.length && WORD.test(text[e])) e++;
  // Trim apostrophes / hyphens hugging the word.
  while (s < e && /['’\-]/.test(text[s])) s++;
  while (e > s && /['’\-]/.test(text[e - 1])) e--;
  if (e <= s) return null;
  return { a: { index: pos.index, offset: s }, b: { index: pos.index, offset: e }, text: text.slice(s, e) };
}

/**
 * What a selection can grow to at `pos`: the whole word there, or a single
 * punctuation mark (so a full stop or a quote can be included on its own,
 * without also taking the next word). Spaces give nothing.
 */
export function selectableAt(spans, pos) {
  const word = wordAt(spans, pos);
  if (word) return word;
  const ch = spans[pos.index].textContent[pos.offset] || '';
  if (!ch || /\s/.test(ch)) return null;
  return { a: { index: pos.index, offset: pos.offset }, b: { index: pos.index, offset: pos.offset + 1 }, text: ch };
}

export const ordered = (a, b) =>
  a.index < b.index || (a.index === b.index && a.offset <= b.offset) ? [a, b] : [b, a];

export function rangeRects(spans, a, b) {
  [a, b] = ordered(a, b);
  const rects = [];
  for (let i = a.index; i <= b.index; i++) {
    const node = spans[i].firstChild;
    const s = i === a.index ? a.offset : 0;
    const e = i === b.index ? b.offset : node.length;
    if (e <= s) continue;
    range.setStart(node, s);
    range.setEnd(node, e);
    for (const r of range.getClientRects()) if (r.width > 0.5) rects.push(r);
  }
  return rects;
}

export function rangeText(spans, a, b) {
  [a, b] = ordered(a, b);
  let out = '';
  let prevRect = null;
  for (let i = a.index; i <= b.index; i++) {
    const t = spans[i].textContent;
    const piece = t.slice(i === a.index ? a.offset : 0, i === b.index ? b.offset : t.length);
    const rect = spans[i].getBoundingClientRect();
    if (out && prevRect) {
      const newLine = Math.abs(rect.top - prevRect.top) > rect.height * 0.5 || spans[i - 1].nextSibling?.nodeName === 'BR';
      if (newLine) {
        if (/[A-Za-z]-$/.test(out)) out = out.slice(0, -1); // re-join hyphenated words
        else if (!/\s$/.test(out)) out += ' ';
      }
    }
    out += piece;
    prevRect = rect;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * A page's text for reading aloud, and where each character came from.
 * Lines are joined the way rangeText joins them (a space, or re-joined
 * hyphenated words), whitespace is collapsed, and a lone page number at the
 * top or bottom of the page is left out.
 * Returns { text, map } with map[k] = { index, offset } into `spans` (or null
 * for a joining space).
 */
export function pageText(spans, layerRect, { furniture = false } = {}) {
  const chars = [];
  const map = [];
  let prevRect = null;
  const skip = furniture && layerRect ? furnitureOf(spans, layerRect, furniture === 'marks') : null;
  for (let i = 0; i < spans.length; i++) {
    if (skip && skip.has(i)) continue;
    const t = spans[i].textContent;
    const rect = spans[i].getBoundingClientRect();
    if (layerRect && /^\s*[\divxlc]{1,4}\s*$/i.test(t)) {
      const y = (rect.top + rect.bottom) / 2 - layerRect.top;
      if (y < layerRect.height * 0.09 || y > layerRect.height * 0.91) continue; // a running page number
    }
    if (chars.length && prevRect) {
      const newLine = Math.abs(rect.top - prevRect.top) > rect.height * 0.5 || (spans[i - 1] && spans[i - 1].nextSibling && spans[i - 1].nextSibling.nodeName === 'BR');
      if (newLine) {
        const n = chars.length;
        if (n > 1 && chars[n - 1] === '-' && /[A-Za-z]/.test(chars[n - 2])) {
          chars.pop();
          map.pop();
        } else if (!/\s/.test(chars[n - 1])) {
          chars.push(' ');
          map.push(null);
        }
      }
    }
    for (let o = 0; o < t.length; o++) {
      chars.push(t[o]);
      map.push({ index: i, offset: o });
    }
    prevRect = rect;
  }
  // Collapse whitespace (keeping the map in step) and trim.
  let text = '';
  const out = [];
  for (let k = 0; k < chars.length; k++) {
    const ws = /\s/.test(chars[k]);
    if (ws && (!text.length || text[text.length - 1] === ' ')) continue;
    text += ws ? ' ' : chars[k];
    out.push(map[k]);
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    out.pop();
  }
  return { text, map: out };
}

const WATERMARK = /^[^\s]*\s*[|·•]?\s*(https?:\/\/)?(www\.)?[\w-]+(\.[\w-]+)*\.(com|net|org|io|co|me|info|to|cc|ru|xyz|site|online)(\/\S*)?\s*$/i;

/**
 * The spans that are the page's furniture rather than its text, so read-aloud
 * passes over them: running heads and feet (set apart from the body by a gap,
 * short or in smaller type), footnotes (smaller type below the body), and
 * site marks or watermarks ("Name | site.com"). A Set of span indexes.
 */
export function furnitureOf(spans, layerRect, marksOnly = false) {
  const H = layerRect.height;
  const lines = [];
  spans.forEach((sp, i) => {
    const t = sp.textContent;
    if (!t || !t.trim()) return;
    const r = sp.getBoundingClientRect();
    if (!r.height) return;
    const cy = (r.top + r.bottom) / 2 - layerRect.top;
    let line = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 4; k--) {
      if (Math.abs(lines[k].cy - cy) < Math.max(lines[k].h, r.height) * 0.5) {
        line = lines[k];
        break;
      }
    }
    if (!line) lines.push((line = { idx: [], cy, top: r.top - layerRect.top, h: r.height, hs: [], text: '' }));
    line.idx.push(i);
    line.hs.push(r.height);
    line.text += t;
    line.top = Math.min(line.top, r.top - layerRect.top);
  });
  const out = new Set();
  if (!lines.length) return out;
  for (const l of lines) {
    l.hs.sort((a, b) => a - b);
    l.h = l.hs[l.hs.length >> 1];
    l.chars = l.text.trim().length;
  }
  lines.sort((a, b) => a.top - b.top);
  // The body's type size: the size most of the page's characters are in.
  const bySize = lines.slice().sort((a, b) => a.h - b.h);
  const total = lines.reduce((n, l) => n + l.chars, 0);
  let acc = 0;
  let bodyH = bySize[0].h;
  for (const l of bySize) {
    acc += l.chars;
    if (acc >= total / 2) {
      bodyH = l.h;
      break;
    }
  }
  const body = lines.filter((l) => l.h > bodyH * 0.85 && l.h < bodyH * 1.2);
  const steps = [];
  for (let k = 1; k < body.length; k++) {
    const d = body[k].top - body[k - 1].top;
    if (d > bodyH * 0.5) steps.push(d);
  }
  steps.sort((a, b) => a - b);
  const step = steps.length ? steps[steps.length >> 1] : bodyH * 1.4;
  const small = (l) => l.h < bodyH * 0.86;
  const brief = (l) => l.chars < 80;
  const mark = (l) => l.idx.forEach((i) => out.add(i));

  // Watermarks and site marks, wherever they are.
  for (const l of lines) if (l.chars < 70 && WATERMARK.test(l.text.trim())) mark(l);
  // (EPUB pages are Folio's own: no running heads or page numbers in their text, only marks the book itself carries.)
  if (marksOnly || body.length < 3) return out; // too little text to tell the body from the rest

  // Foot of the page: page numbers, running feet, site marks, footnotes.
  for (let k = lines.length - 1; k > 0; k--) {
    const l = lines[k];
    const inFoot = l.top > H * 0.82 && (brief(l) || small(l));
    const note = small(l) && l.top > H * 0.5;
    if (!inFoot && !note) break;
    if (l.top - lines[k - 1].top > step * 1.6) {
      for (let j = k; j < lines.length; j++) mark(lines[j]);
    }
  }
  // Head of the page: running titles, chapter names, page numbers.
  for (let k = 0; k < lines.length - 1; k++) {
    const l = lines[k];
    if (!(l.top < H * 0.14 && (brief(l) || small(l)))) break;
    if (lines[k + 1].top - l.top > step * 1.6) {
      for (let j = 0; j <= k; j++) mark(lines[j]);
    }
  }
  return out;
}

/**
 * Split text into sentences of at most `max` characters (longer sentences at
 * a clause, else a word), as [start, end) offsets, starting at `from`.
 */
export function sentenceRanges(text, from = 0, max = 180) {
  const out = [];
  let s = from;
  while (s < text.length && text[s] === ' ') s++;
  while (s < text.length) {
    const window = text.slice(s, s + max + 1);
    let cut = -1;
    if (s + max >= text.length) {
      // The rest fits: still stop at the first sentence end.
      const m = /[.!?…]["'”’)\]]*\s/.exec(window);
      cut = m ? m.index + m[0].length : window.length;
    } else {
      const m = /[.!?…]["'”’)\]]*\s/.exec(window);
      if (m) cut = m.index + m[0].length;
      else {
        for (const re of [/[,;:—–]\s/g, /\s/g]) {
          let mm;
          re.lastIndex = 0;
          while ((mm = re.exec(window))) if (mm.index > 30) cut = mm.index + mm[0].length;
          if (cut > 0) break;
        }
      }
      if (cut <= 0) cut = max;
    }
    let e = s + cut;
    let t = e;
    while (t > s && text[t - 1] === ' ') t--;
    if (t > s) out.push([s, t]);
    s = e;
    while (s < text.length && text[s] === ' ') s++;
  }
  return out;
}
