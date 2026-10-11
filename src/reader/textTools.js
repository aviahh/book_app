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
export function pageText(spans, layerRect) {
  const chars = [];
  const map = [];
  let prevRect = null;
  for (let i = 0; i < spans.length; i++) {
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
