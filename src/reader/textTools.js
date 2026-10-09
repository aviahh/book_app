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
