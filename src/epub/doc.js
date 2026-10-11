// A typeset EPUB dressed up as a PDF.js document: the reader asks it for
// pages, draws them on canvases, builds their text layers, links and table of
// contents exactly as it does for PDFs.
import { measure, fontOf, ASCENT } from './layout.js';

// Paper and ink for each page tone (paper matches PDF pages' tones).
const INK = {
  original: { paper: '#ffffff', ink: '#1f1c18', link: '#7a5524', dim: 0 },
  warm: { paper: '#f6ead3', ink: '#3b2f22', link: '#7a5524', dim: 0 },
  night: { paper: '#1d1b18', ink: '#d6cec1', link: '#dcb983', dim: 0.14 },
};

export class EpubDoc {
  constructor(epub, layout) {
    this.epub = epub;
    this.layout = layout;
    this.numPages = layout.pages.length;
    this.images = new Map(); // path → { promise, url }
    this.pageObjs = new Map();
    this.reflowable = true;
  }

  getPage(n) {
    if (!this.pageObjs.has(n)) this.pageObjs.set(n, new EpubPage(this, n));
    return Promise.resolve(this.pageObjs.get(n));
  }

  /** Page index (0-based) a link or contents entry points at. */
  target(t) {
    if (!t) return -1;
    const a = this.layout.anchors;
    let i = t.frag && a.has(`${t.path}#${t.frag}`) ? a.get(`${t.path}#${t.frag}`) : a.get(t.path);
    if (i === undefined) return -1;
    return Math.min(i, this.numPages - 1);
  }

  async getOutline() {
    const walk = (items) => items.map((it) => ({ title: it.title, dest: (() => { const i = this.target(it.target); return i >= 0 ? [i] : null; })(), items: walk(it.items || []) }));
    return walk(this.epub.toc);
  }

  async getDestination(d) {
    return d;
  }

  async getPageIndex(ref) {
    return typeof ref === 'number' ? ref : -1;
  }

  async getMetadata() {
    return { info: { Title: this.epub.title, Author: this.epub.author } };
  }

  /** A picture from the book, decoded (a few are kept). */
  image(path) {
    let e = this.images.get(path);
    if (e) {
      this.images.delete(path);
      this.images.set(path, e);
      return e.promise;
    }
    const url = URL.createObjectURL(this.epub.blob(path));
    e = {
      url,
      promise: new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      }),
    };
    this.images.set(path, e);
    for (const [k, old] of this.images) {
      if (this.images.size <= 10) break;
      this.images.delete(k);
      URL.revokeObjectURL(old.url);
    }
    return e.promise;
  }

  destroy() {
    for (const e of this.images.values()) URL.revokeObjectURL(e.url);
    this.images.clear();
  }
}

class EpubPage {
  constructor(doc, n) {
    this.doc = doc;
    this.n = n;
    this.data = doc.layout.pages[n - 1];
    this.selfToned = true; // draws its own page tones (PDF pages get recoloured afterwards)
  }

  getViewport({ scale = 1 } = {}) {
    const { W, H } = this.doc.layout;
    return {
      width: W * scale,
      height: H * scale,
      scale,
      convertToViewportPoint: (x, y) => [x * scale, y * scale],
    };
  }

  /** Baseline of a line. */
  #baseline(l) {
    return l.y + (l.h - l.size) / 2 + l.size * ASCENT;
  }

  render({ canvasContext: ctx, viewport, tone = 'original' }) {
    return { promise: this.#draw(ctx, viewport.scale, INK[tone] || INK.original) };
  }

  async #draw(ctx, scale, colors) {
    const L = this.doc.layout;
    const p = this.data;
    const pics = [];
    for (const im of p.imgs) pics.push(this.doc.image(im.path).then((img) => ({ im, img })));
    for (const l of p.lines) for (const r of l.runs) if (r.img) pics.push(this.doc.image(r.img).then((img) => ({ im: { path: r.img, x: r.x, y: 0, w: r.w, h: r.h, line: l }, img })));
    const loaded = await Promise.all(pics);

    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = colors.paper;
    ctx.fillRect(0, 0, L.W, L.H);
    const tiny = L.size * scale < 5; // thumbnails: suggest the lines instead of drawing letters

    for (const { im, img } of loaded) {
      if (!img) continue;
      let { x, y, w, h } = im;
      if (im.line) {
        y = this.#baseline(im.line) - h * 0.85;
        x += L.mx;
      }
      if (im.fit) {
        // A full-page picture: fill the page if it's nearly the same shape, else fit it in.
        const ia = img.naturalWidth / img.naturalHeight;
        const pa = L.W / L.H;
        const fill = Math.abs(ia / pa - 1) < 0.12;
        if ((ia > pa) === !fill) (w = L.W), (h = L.W / ia);
        else (h = L.H), (w = L.H * ia);
        x = (L.W - w) / 2;
        y = (L.H - h) / 2;
      }
      ctx.drawImage(img, x, y, w, h);
      if (colors.dim) {
        ctx.fillStyle = `rgba(0,0,0,${colors.dim})`;
        ctx.fillRect(x, y, w, h);
      }
    }

    ctx.textBaseline = 'alphabetic';
    for (const l of p.lines) {
      const by = this.#baseline(l);
      for (const r of l.runs) {
        if (r.img || !r.t) continue;
        const font = fontOf(r.st, L.family);
        const y = by + (r.st.sh || 0) * l.base;
        ctx.fillStyle = r.st.a ? colors.link : colors.ink;
        if (tiny) {
          ctx.globalAlpha = 0.35;
          ctx.fillRect(L.mx + r.x, y - r.st.s * 0.5, measure(font, r.t.replace(/ +$/, '')) + (r.t.split(' ').length - 1) * (r.ws || 0), r.st.s * 0.45);
          ctx.globalAlpha = 1;
          continue;
        }
        ctx.font = font;
        if (r.rtl || !r.ws) {
          ctx.fillText(r.t, L.mx + r.x, y);
          continue;
        }
        // Justified: word by word, so the spaces stretch.
        const space = measure(font, ' ') + r.ws;
        let x = L.mx + r.x;
        for (const word of r.t.split(' ')) {
          if (word) ctx.fillText(word, x, y);
          x += measure(font, word) + space;
        }
      }
    }
    for (const rule of p.rules) {
      ctx.fillStyle = colors.ink;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(rule.x, rule.y, rule.w, 1);
      ctx.globalAlpha = 1;
    }
    // Page number at the foot, as in a printed book.
    if (!p.full && !tiny) {
      ctx.font = `400 ${Math.round(L.size * 0.72)}px ${L.family}`;
      ctx.fillStyle = colors.ink;
      ctx.globalAlpha = 0.45;
      ctx.textAlign = 'center';
      ctx.fillText(String(this.n), L.W / 2, L.H - L.mb * 0.42);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  async getTextContent() {
    const items = [];
    for (const l of this.data.lines) {
      const str = l.runs
        .filter((r) => r.t)
        .map((r) => r.t)
        .join('');
      if (str) items.push({ str, hasEOL: true });
    }
    return { items, styles: {} };
  }

  async getAnnotations() {
    const L = this.doc.layout;
    const out = [];
    for (const l of this.data.lines) {
      const by = this.#baseline(l);
      for (const r of l.runs) {
        if (!r.t || !r.st.a) continue;
        const dest = this.doc.target(r.st.a);
        if (dest < 0) continue;
        const font = fontOf(r.st, L.family);
        const text = r.t.replace(/ +$/, '');
        const w = measure(font, text) + (text.split(' ').length - 1) * (r.ws || 0);
        const top = by + (r.st.sh || 0) * l.base - r.st.s * ASCENT;
        // Small links (note numbers) get a bigger area to tap.
        const padX = Math.max(0, (L.size * 1.4 - w) / 2);
        out.push({ subtype: 'Link', rect: [L.mx + r.x - padX, top, L.mx + r.x + w + padX, top + r.st.s * 1.15], dest: [dest] });
      }
    }
    return out;
  }

  /** The text layer: invisible words over the drawn ones, for selecting, translating and reading aloud. */
  buildTextLayer(container, cssWidth) {
    const L = this.doc.layout;
    const k = cssWidth / L.W;
    container.classList.add('reflow');
    const spans = [];
    const frag = document.createDocumentFragment();
    for (const l of this.data.lines) {
      const by = this.#baseline(l);
      for (const r of l.runs) {
        if (!r.t) continue;
        const s = document.createElement('span');
        s.setAttribute('role', 'presentation');
        s.textContent = r.t;
        const st = r.st;
        const top = by + (st.sh || 0) * l.base - st.s * ASCENT;
        s.style.cssText = `left:${(L.mx + r.x) * k}px;top:${top * k}px;font-size:${st.s * k}px;font-family:${st.m ? 'monospace' : L.family.replace(/"/g, "'")};font-style:${st.i ? 'italic' : 'normal'};font-weight:${st.b ? 700 : 400};${r.ws ? `word-spacing:${r.ws * k}px;` : ''}transform:none`;
        if (r.rtl) s.dir = 'rtl';
        const font = fontOf(st, L.family);
        spans.push([s, (measure(font, r.t) + (r.t.split(' ').length - 1) * (r.ws || 0)) * k]);
        frag.append(s);
      }
    }
    container.append(frag);
    // Match each word's width to the drawn one exactly (the screen may round font sizes).
    const box = container.getBoundingClientRect();
    const zoom = container.offsetWidth ? box.width / container.offsetWidth : 0;
    if (!zoom) return Promise.resolve();
    const actual = spans.map(([s]) => s.getBoundingClientRect().width / zoom);
    spans.forEach(([s, want], i) => {
      const a = actual[i];
      if (a > 0 && want > 0 && Math.abs(want / a - 1) > 0.01) s.style.transform = `scaleX(${want / a})`;
    });
    return Promise.resolve();
  }
}
