// Typesetting an EPUB into pages.
//
// Each chapter's XHTML is put into a hidden, script-free frame together with
// the book's stylesheets, so the browser works out the styles (italics,
// headings, centring, indents, margins…). Folio then breaks the text into
// lines and pages itself, with its own font and size, so every page is a
// fixed picture like a PDF page: it can be drawn on a canvas, turned,
// zoomed and searched by the same reader.
//
// Positions inside a chapter are counted in characters ("offsets"); they stay
// the same whatever the font or page size, so pages can be found again after
// the text is set differently.
import { resolvePath, imageSize } from './epub.js';
import { FONTS } from './fonts.js';

export { FONTS };

export const SPACING = { compact: 1.35, normal: 1.5, relaxed: 1.7 };
const MONO = 'Menlo, Consolas, "Courier New", monospace';
const LAYOUT_VERSION = 2;
export const ASCENT = 0.82; // baseline below the top of a 1em box (matches a text span with line-height 1)

const CJK = /[⺀-⿿　-〿぀-ヿ㄀-ㇿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;
const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ӿ]/;

/**
 * The page size text is set for on this device, in CSS pixels. It comes from
 * the screen (not the window), so it stays the same every time the book opens:
 * tablets get the size of one page of the two-page spread in landscape,
 * phones a page that fills the screen in portrait.
 */
export function pageBox() {
  const a = Math.round(window.screen.width || window.innerWidth);
  const b = Math.round(window.screen.height || window.innerHeight);
  const long = Math.max(a, b);
  const short = Math.min(a, b);
  const r10 = (n) => Math.round(n / 10) * 10;
  if (short < 600) {
    const W = r10(short - 2 * Math.max(10, short * 0.025));
    return { W, H: r10(Math.min(long * 0.94, W / 0.5)) };
  }
  const vpad = Math.max(18, short * 0.035);
  const hpad = Math.max(56, long * 0.05);
  const H = r10(short - 2 * vpad);
  const W = r10(Math.max(H * 0.62, Math.min((long - 2 * hpad) / 2, H * 0.8)));
  return { W, H };
}

/** Body text size (px) for the user's size setting (100 = this device's normal). */
export function textSize(W, percent = 100) {
  const base = Math.min(21, Math.max(16, W / 27));
  return Math.round(base * (percent / 100) * 2) / 2;
}

export function layoutKey(o) {
  return `v${LAYOUT_VERSION}|${o.W}x${o.H}|${o.font}|${o.size}|${o.spacing}`;
}

/** Make sure the reading font is loaded, so measuring and drawing use it. */
export async function loadFonts(font) {
  const fam = (FONTS[font] || FONTS.literata).family;
  if (!document.fonts || !document.fonts.load) return;
  const sample = 'AaĀŁЖ';
  const loads = [];
  for (const st of ['normal', 'italic']) for (const w of [400, 700]) loads.push(document.fonts.load(`${st} ${w} 16px ${fam}`, sample).catch(() => {}));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 4000))]);
}

// ------------------------------------------------------------------ measuring

const measureCtx = document.createElement('canvas').getContext('2d');
const widths = new Map();
export function fontOf(st, family) {
  return `${st.i ? 'italic ' : ''}${st.b ? 700 : 400} ${st.s}px ${st.m ? MONO : family}`;
}
export function measure(font, text) {
  const k = font + '\u0001' + text;
  let w = widths.get(k);
  if (w === undefined) {
    if (measureCtx.font !== font) measureCtx.font = font;
    w = measureCtx.measureText(text).width;
    if (widths.size > 60000) widths.clear();
    widths.set(k, w);
  }
  return w;
}

// ------------------------------------------------------------------ styles from the frame

function makeFrame(width) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin'); // no scripts from the book ever run
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${Math.round(width)}px;height:200px;border:0;visibility:hidden;pointer-events:none`;
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write('<!DOCTYPE html><html><head></head><body></body></html>');
  doc.close();
  return frame;
}

const cleanCss = (css) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[^;]*;/gi, '')
    .replace(/@font-face\s*\{[^}]*\}/gi, '')
    .replace(/url\([^)]*\)/gi, 'none');

const STRIP = 'script,link,iframe,object,embed,video,audio,source,track,form,input,button,textarea,select,meta,title';

function parseChapter(text) {
  let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length || !doc.body) doc = new DOMParser().parseFromString(text, 'text/html');
  return doc;
}

/**
 * One chapter's content as blocks: paragraphs (lists of styled text runs),
 * pictures, rules and page breaks, with sizes in px for body text of `size`.
 */
function chapterBlocks(epub, path, frame, size, hyphenate) {
  const src = parseChapter(epub.text(path));
  const fdoc = frame.contentDocument;
  // Stylesheets: linked ones and <style> blocks, made harmless (no fonts, no network).
  let css = '';
  for (const el of src.querySelectorAll('link, style')) {
    if (el.localName === 'style') css += el.textContent + '\n';
    else if (/stylesheet/i.test(el.getAttribute('rel') || '') && el.getAttribute('href')) {
      try {
        css += epub.text(resolvePath(path, el.getAttribute('href')).path) + '\n';
      } catch (e) {}
    }
  }
  fdoc.head.innerHTML = '';
  const style = fdoc.createElement('style');
  style.textContent = `${cleanCss(css)}
html{font-size:${size}px!important}
body{margin:0!important;padding:0!important;font-size:${size}px!important;max-width:none!important;columns:auto!important}
img,svg,image{max-width:none}`;
  fdoc.head.append(style);
  // Pictures: keep where they point, without letting the frame load anything.
  for (const img of src.querySelectorAll('img')) {
    img.setAttribute('data-src', img.getAttribute('src') || '');
    img.removeAttribute('src');
    img.removeAttribute('srcset');
  }
  for (const im of src.getElementsByTagName('image')) {
    const href = im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    im.setAttribute('data-src', href);
    im.removeAttribute('href');
    im.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
  }
  for (const el of src.querySelectorAll(STRIP)) el.remove();
  const body = fdoc.body;
  body.textContent = '';
  // Nothing carries over from the previous chapter.
  for (const a of ['dir', 'lang', 'class', 'style', 'id']) body.removeAttribute(a);
  const htmlEl = src.documentElement;
  const dir = (src.body && src.body.getAttribute('dir')) || (htmlEl && htmlEl.getAttribute('dir'));
  if (dir) body.setAttribute('dir', dir);
  const lang = htmlEl && (htmlEl.getAttribute('lang') || htmlEl.getAttribute('xml:lang'));
  if (lang) body.setAttribute('lang', lang);
  if (src.body) {
    // Classes on <body> often carry the chapter's styles.
    if (src.body.getAttribute('class')) body.setAttribute('class', src.body.getAttribute('class'));
    for (const n of Array.prototype.slice.call(src.body.childNodes)) body.append(fdoc.importNode(n, true));
  }
  const win = frame.contentWindow;

  const blocks = [];
  const anchors = new Map();
  let offset = 0;
  let para = null;
  let gap = 0;

  const px = (v) => {
    const n = parseFloat(v);
    return isFinite(n) ? n : 0;
  };
  const flush = () => {
    if (para) {
      // Trim the paragraph's leading and trailing spaces.
      const runs = para.runs;
      while (runs.length && !runs[0].br && !(runs[0].t = runs[0].t.replace(/^ +/, ''))) runs.shift();
      while (runs.length && !runs[runs.length - 1].br && !(runs[runs.length - 1].t = runs[runs.length - 1].t.replace(/ +$/, ''))) runs.pop();
      while (runs.length && runs[runs.length - 1].br) runs.pop();
      if (runs.length) {
        para.mt = Math.max(para.mt, gap);
        gap = 0;
        blocks.push(para);
      }
    }
    para = null;
  };
  const startPara = (box) => {
    para = { kind: 'text', runs: [], align: box.align, indent: box.indent, ml: box.ml, mr: box.mr, mt: box.mt, dir: box.dir, pre: box.pre, size: box.size, heading: box.heading, o: offset };
    box.mt = 0; // only the first paragraph of a block gets its top margin
  };
  const addText = (t, st, box) => {
    if (!box.pre) t = t.replace(/[ \t\n\r\f]+/g, ' ');
    if (!t) return;
    // Places long words may break, as in a printed book (soft hyphens).
    if (hyphenate && !box.pre && /[a-z]{6}/i.test(t)) t = hyphenate(t);
    if (!para) {
      if (!box.pre && t === ' ') return;
      startPara(box);
    }
    const last = para.runs[para.runs.length - 1];
    if (!box.pre && t[0] === ' ' && (!last || last.br || / $/.test(last.t))) t = t.slice(1);
    if (!t) return;
    if (st.u) t = st.u === 'uppercase' ? t.toUpperCase() : st.u === 'lowercase' ? t.toLowerCase() : t;
    if (box.pre && t.indexOf('\n') >= 0) {
      t.split('\n').forEach((piece, i) => {
        if (i) para.runs.push({ br: true, o: offset++ });
        if (piece) {
          para.runs.push({ t: piece, st, o: offset });
          offset += piece.length;
        }
      });
      return;
    }
    if (last && !last.br && last.st === st) last.t += t;
    else para.runs.push({ t, st, o: offset });
    offset += t.length;
  };
  const addImage = (el, box, st) => {
    const ref = el.getAttribute('data-src');
    if (!ref || /^(https?:|data:)/i.test(ref)) return;
    const ipath = resolvePath(path, ref).path;
    if (!epub.has(ipath)) return;
    let dim = null;
    try {
      dim = imageSize(epub.bytes(ipath));
    } catch (e) {}
    if (!dim || !dim.w || !dim.h) dim = { w: 600, h: 800 };
    // Small pictures sitting in a line of text (special characters, icons) stay in the line.
    if (dim.h <= size * 2.2 && dim.w <= size * 8 && para) {
      const h = Math.min(dim.h, st.s * 1.1);
      para.runs.push({ img: ipath, w: (dim.w / dim.h) * h, h, st, o: offset++ });
      return;
    }
    flush();
    // Pictures get a little air above and below.
    blocks.push({ kind: 'img', path: ipath, w: dim.w, h: dim.h, mt: Math.max(gap, box.mt, size * 0.7), align: box.align, o: offset++ });
    box.mt = 0;
    gap = size * 0.7;
  };

  const BLOCK = /^(block|list-item|table|table-row|table-caption|table-row-group|table-header-group|table-footer-group|flex|grid|flow-root|-webkit-box)$/;
  const walk = (node, st, box) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        addText(n.data, st, box);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = (n.localName || '').toLowerCase();
      const id = n.getAttribute('id') || (tag === 'a' && n.getAttribute('name'));
      if (id && !anchors.has(id)) anchors.set(id, offset);
      if (tag === 'br') {
        if (para) para.runs.push({ br: true, o: offset++ });
        continue;
      }
      const cs = win.getComputedStyle(n);
      if (!cs || cs.display === 'none') continue;
      if (tag === 'img' || tag === 'image') {
        addImage(n, box, st);
        continue;
      }
      if (tag === 'svg') {
        const im = n.getElementsByTagName('image')[0];
        if (im) addImage(im, box, st);
        continue;
      }
      if (tag === 'hr') {
        flush();
        blocks.push({ kind: 'hr', mt: Math.max(gap, px(cs.marginTop), size * 0.8), o: offset });
        gap = Math.max(px(cs.marginBottom), size * 0.8);
        continue;
      }
      if (tag === 'rt' || tag === 'rp') continue; // ruby readings: keep the base text only
      const fs = px(cs.fontSize) || st.s;
      const fw = cs.fontWeight === 'bold' || cs.fontWeight === 'bolder' ? 700 : parseInt(cs.fontWeight, 10) || 400;
      const va = cs.verticalAlign;
      const href = tag === 'a' && n.getAttribute('href');
      const nst = {
        s: va === 'super' || va === 'sub' ? Math.min(fs, st.s * 0.72) : fs,
        i: cs.fontStyle !== 'normal' ? 1 : 0,
        b: fw >= 600 ? 1 : 0,
        m: /mono|courier/i.test(cs.fontFamily) ? 1 : 0,
        sh: va === 'super' ? -0.38 : va === 'sub' ? 0.18 : st.sh || 0,
        u: cs.textTransform !== 'none' ? cs.textTransform : st.u,
        a: href ? resolvePath(path, href) : st.a,
      };
      const same = nst.s === st.s && nst.i === st.i && nst.b === st.b && nst.m === st.m && nst.sh === st.sh && nst.u === st.u && nst.a === st.a;
      const cst = same ? st : nst;
      if (!BLOCK.test(cs.display)) {
        walk(n, cst, box);
        continue;
      }
      // A block: its own paragraph(s).
      flush();
      if (cs.pageBreakBefore === 'always' || cs.breakBefore === 'page' || cs.pageBreakBefore === 'left' || cs.pageBreakBefore === 'right') {
        if (blocks.length) blocks.push({ kind: 'break' });
        gap = 0;
      }
      const mt = Math.min(Math.max(0, px(cs.marginTop) + px(cs.paddingTop)), size * 4);
      gap = Math.max(gap, mt);
      const align = cs.textAlign;
      const isHeading = /^h[1-6]$/.test(tag) || (fs >= size * 1.25 && fw >= 600);
      const indentPx = /px$/.test(cs.textIndent) ? px(cs.textIndent) : 0;
      const nbox = {
        align,
        indent: Math.max(-size * 3, Math.min(indentPx, size * 6)),
        ml: Math.min(box.ml + Math.max(0, px(cs.marginLeft) + px(cs.paddingLeft)), size * 8),
        mr: Math.min(box.mr + Math.max(0, px(cs.marginRight) + px(cs.paddingRight)), size * 8),
        mt: 0,
        dir: cs.direction,
        pre: /^pre/.test(cs.whiteSpace),
        size: fs,
        heading: isHeading,
      };
      if (cs.display === 'list-item') {
        const list = n.parentNode;
        let marker = '•';
        if (list && list.localName === 'ol') {
          let k = parseInt(list.getAttribute('start'), 10) || 1;
          for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === 'li') k++;
          marker = `${k}.`;
        }
        if (cs.listStyleType !== 'none') {
          // The marker hangs in the margin: wrapped lines line up with the text, not the bullet.
          const hang = marker === '•' ? size * 0.9 : size * (0.45 + 0.55 * marker.length);
          nbox.indent = -hang;
          nbox.ml += hang;
          startPara(nbox);
          para.runs.push({ t: marker + ' ', st: cst, o: offset });
        }
      }
      walk(n, cst, nbox);
      flush();
      gap = Math.max(gap, Math.min(Math.max(0, px(cs.marginBottom) + px(cs.paddingBottom)), size * 4));
      if (cs.pageBreakAfter === 'always' || cs.breakAfter === 'page') {
        blocks.push({ kind: 'break' });
        gap = 0;
      }
    }
  };
  const bcs = win.getComputedStyle(body);
  const rootStyle = { s: size, i: 0, b: 0, m: 0, sh: 0, u: null, a: null };
  walk(body, rootStyle, { align: bcs.textAlign, indent: 0, ml: 0, mr: 0, mt: 0, dir: bcs.direction, pre: false, size, heading: false });
  flush();

  // Books that give sizes in fixed units: scale so their usual paragraph text is the chosen size.
  const counts = new Map();
  for (const b of blocks) if (b.kind === 'text' && !b.heading) for (const r of b.runs) if (r.t) counts.set(r.st.s, (counts.get(r.st.s) || 0) + r.t.length);
  let common = size;
  let most = 0;
  for (const [s, c] of counts) if (c > most) (most = c), (common = s);
  const k = Math.min(1.6, Math.max(0.6, size / common));
  if (Math.abs(k - 1) > 0.02) {
    const seen = new Set();
    for (const b of blocks) {
      if (b.kind !== 'text') continue;
      b.size *= k;
      b.indent *= k;
      for (const r of b.runs) if (r.st && !seen.has(r.st)) seen.add(r.st), (r.st.s *= k);
    }
  }
  return { blocks, anchors, length: offset };
}

// ------------------------------------------------------------------ lines

function paraLines(b, o, contentW) {
  const fam = o.family;
  const rtl = b.dir === 'rtl' || (b.dir !== 'ltr' && autoRtl(b));
  const units = []; // glued boxes that must stay on one line
  let cur = null;
  const push = (box, breakAfter, space) => {
    if (!cur) cur = { boxes: [], w: 0 };
    cur.boxes.push(box);
    cur.w += box.w;
    if (breakAfter) {
      cur.space = space;
      cur.spaceW = space ? measure(fontOf(box.st, fam), ' ') : 0;
      cur.shy = box.shy;
      units.push(cur);
      cur = null;
    }
  };
  for (const r of b.runs) {
    if (r.br) {
      if (cur) units.push(cur), (cur = null);
      units.push({ br: true, o: r.o });
      continue;
    }
    if (r.img) {
      push({ img: r.img, w: r.w, h: r.h, st: r.st, o: r.o, t: '' }, false);
      continue;
    }
    const font = fontOf(r.st, fam);
    const t = r.t;
    let i = 0;
    while (i < t.length) {
      const c = t[i];
      if (c === ' ') {
        if (cur) {
          cur.boxes[cur.boxes.length - 1].sp = 1;
          const last = cur.boxes[cur.boxes.length - 1];
          cur.space = true;
          cur.spaceW = measure(fontOf(last.st, fam), ' ');
          units.push(cur);
          cur = null;
        } else if (units.length && !units[units.length - 1].br && !units[units.length - 1].space) {
          const u = units[units.length - 1];
          u.space = true;
          u.spaceW = measure(fontOf(u.boxes[u.boxes.length - 1].st, fam), ' ');
        }
        i++;
        continue;
      }
      if (CJK.test(c)) {
        push({ t: c, st: r.st, w: measure(font, c), o: r.o + i }, !/[、。，．）」』】〉》！？：；]/.test(t[i + 1] || ''), false);
        i++;
        continue;
      }
      let j = i;
      let shy = false;
      while (j < t.length && t[j] !== ' ' && !CJK.test(t[j])) {
        if (t[j] === '­') {
          shy = true;
          break;
        }
        j++;
        if (/[-–—\/]/.test(t[j - 1]) && j - i > 1 && j < t.length && t[j] !== ' ') break;
      }
      const piece = t.slice(i, j);
      const dash = /[-–—\/]$/.test(piece) && j < t.length && t[j] !== ' ';
      if (piece) push({ t: piece, st: r.st, w: measure(font, piece), o: r.o + i, shy }, shy || dash, false);
      i = j + (shy ? 1 : 0);
    }
  }
  if (cur) units.push(cur);

  const lines = [];
  const lead = o.spacing;
  let line = [];
  let lw = 0;
  const avail = () => (rtl ? contentW - b.ml - (lines.length === 0 ? Math.max(0, b.mr + b.indent) : b.mr) : contentW - b.mr - (lines.length === 0 ? Math.max(0, b.ml + b.indent) : b.ml));
  const end = (hard) => {
    if (!line.length && !hard) return;
    const made = makeLine(line, lw, hard, lines.length === 0);
    hyphRun = made.hyph ? hyphRun + 1 : 0;
    lines.push(made);
    line = [];
    lw = 0;
  };
  // The line is full. If it would end inside a word (at a soft hyphen), only
  // hyphenate when ending at the last whole word would leave gaping spaces,
  // and never more than two hyphenated lines in a row.
  let hyphRun = 0;
  const breakLine = () => {
    if (line[line.length - 1].shy) {
      let k = line.length - 1;
      while (k >= 0 && !line[k].space) k--;
      if (k >= 0) {
        let wk = 0;
        let sp = 0;
        for (let i = 0; i <= k; i++) {
          wk += line[i].w;
          if (i < k && line[i].space) (wk += line[i].spaceW), sp++;
        }
        const gap = sp ? (avail() - wk) / sp : Infinity;
        if (hyphRun >= 2 || gap < b.size * 0.45) {
          const carry = line.slice(k + 1);
          line = line.slice(0, k + 1);
          lw = wk;
          end(false);
          for (const c of carry) {
            const pv = line[line.length - 1];
            lw += (pv && pv.space ? pv.spaceW : 0) + c.w;
            line.push(c);
          }
          return;
        }
      }
    }
    end(false);
  };
  const makeLine = (us, w, hard, firstLine) => {
    let size = b.size;
    for (const u of us) for (const x of u.boxes) size = Math.max(size, x.img ? x.h : x.st.s);
    const last = us[us.length - 1];
    let hyph = false;
    if (!hard && last && last.shy) hyph = true;
    return { us, w, hard, first: firstLine, h: Math.round(size * lead * 100) / 100, size, base: b.size, hyph };
  };
  for (const u of units) {
    if (u.br) {
      end(true);
      continue;
    }
    const prev = line[line.length - 1];
    const sep = prev && prev.space ? prev.spaceW : 0;
    let max = avail();
    if (line.length && lw + sep + u.w > max + 0.5) {
      breakLine();
      max = avail();
      const p2 = line[line.length - 1];
      if (line.length && lw + (p2 && p2.space ? p2.spaceW : 0) + u.w > max + 0.5) end(false);
    }
    if (!line.length && u.w > max) {
      // A word longer than the line: split it where it has to be.
      for (const piece of splitUnit(u, max, fam)) {
        if (line.length) end(false);
        line.push(piece);
        lw = piece.w;
      }
      continue;
    }
    lw += (line.length && line[line.length - 1].space ? line[line.length - 1].spaceW : 0) + u.w;
    line.push(u);
  }
  if (line.length) end(true);
  else if (lines.length) lines[lines.length - 1].hard = true;
  // Place each line's runs: x from the content's left edge.
  for (const ln of lines) placeLine(ln, b, contentW, rtl, fam);
  return lines;
}

function splitUnit(u, max, fam) {
  const out = [];
  let cur = { boxes: [], w: 0 };
  for (const box of u.boxes) {
    if (box.img) {
      cur.boxes.push(box);
      cur.w += box.w;
      continue;
    }
    const font = fontOf(box.st, fam);
    let start = 0;
    for (let k = 1; k <= box.t.length; k++) {
      const w = measure(font, box.t.slice(start, k));
      if (cur.w + w > max && k - 1 > start) {
        const part = box.t.slice(start, k - 1);
        cur.boxes.push({ t: part, st: box.st, w: measure(font, part), o: box.o + start });
        cur.w += measure(font, part);
        out.push(cur);
        cur = { boxes: [], w: 0 };
        start = k - 1;
      }
    }
    const rest = box.t.slice(start);
    cur.boxes.push({ t: rest, st: box.st, w: measure(font, rest), o: box.o + start, sp: box.sp });
    cur.w += measure(font, rest);
  }
  cur.space = u.space;
  cur.spaceW = u.spaceW;
  cur.shy = u.shy;
  out.push(cur);
  return out;
}

function autoRtl(b) {
  let r = 0;
  let l = 0;
  for (const run of b.runs) {
    if (!run.t) continue;
    for (let i = 0; i < run.t.length && i < 200; i++) {
      if (RTL_CHAR.test(run.t[i])) r++;
      else if (LTR_CHAR.test(run.t[i])) l++;
    }
  }
  return r > l;
}

/** Turn a line's units into positioned text runs: { x, t, st, ws } (x from the content's left edge). */
function placeLine(ln, b, contentW, rtl, fam) {
  // The first line's indent is on the side the text starts from.
  const left = !rtl && ln.first ? Math.max(0, b.ml + b.indent) : b.ml;
  const right = rtl && ln.first ? contentW - Math.max(0, b.mr + b.indent) : contentW - b.mr;
  const width = right - left;
  let w = ln.w;
  const hyphenW = ln.hyph ? measure(fontOf(ln.us[ln.us.length - 1].boxes.slice(-1)[0].st, fam), '-') : 0;
  w += hyphenW;
  let spaces = 0;
  for (let i = 0; i < ln.us.length - 1; i++) if (ln.us[i].space) spaces++;
  let align = b.align;
  if (align === 'start' || align === '-webkit-auto' || !align) align = rtl ? 'right' : 'left';
  if (align === 'end') align = rtl ? 'left' : 'right';
  if (align === '-webkit-center') align = 'center';
  // Body text is justified like a printed book, except a paragraph's last line.
  const justify = !ln.hard && spaces > 0 && !b.pre && !b.heading && (align === 'justify' || align === 'left' || align === 'right') && b.align !== 'center';
  let extra = justify ? (width - w) / spaces : 0;
  if (extra > b.size * 3) extra = 0; // far too stretched (a very long word follows): leave the line ragged
  const shift = extra ? 0 : align === 'center' ? (width - w) / 2 : align === 'right' ? width - w : 0;
  const runs = [];
  if (!rtl) {
    let x = left + shift;
    let run = null;
    ln.us.forEach((u, ui) => {
      u.boxes.forEach((box, bi) => {
        if (box.img) {
          runs.push({ x, img: box.img, w: box.w, h: box.h, st: box.st, o: box.o });
          run = null;
          x += box.w;
          return;
        }
        if (run && run.st === box.st) run.t += box.t;
        else {
          run = { x, t: box.t, st: box.st, ws: extra, o: box.o };
          runs.push(run);
        }
        x += box.w;
      });
      const lastUnit = ui === ln.us.length - 1;
      if (!lastUnit && u.space) {
        if (run) run.t += ' ';
        x += u.spaceW + extra;
      }
      if (lastUnit && ln.hyph && run) run.t += '-';
    });
  } else {
    // Right to left: units from the right edge leftwards; each unit is drawn as it reads.
    let x = left + width - shift;
    ln.us.forEach((u, ui) => {
      x -= u.w;
      let bx = x;
      for (const box of u.boxes) {
        if (box.img) runs.push({ x: bx, img: box.img, w: box.w, h: box.h, st: box.st, o: box.o });
        else runs.push({ x: bx, t: box.t + (ui < ln.us.length - 1 && u.space && box === u.boxes[u.boxes.length - 1] ? ' ' : ''), st: box.st, ws: 0, o: box.o, rtl: 1 });
        bx += box.w;
      }
      if (u.space) x -= u.spaceW + extra;
    });
  }
  ln.runs = runs;
  ln.o = ln.us.length ? ln.us[0].boxes[0].o : 0;
  delete ln.us;
}

// ------------------------------------------------------------------ pages

/**
 * Lay out the whole book. Returns { W, H, pages, chapters, anchors, key }:
 * pages[i] = { ch, o, lines:[{y, runs}], imgs, rules, full }.
 */
export async function layoutBook(epub, opts, onProgress) {
  const { W, H, size } = opts;
  const family = (FONTS[opts.font] || FONTS.literata).family;
  const spacing = SPACING[opts.spacing] || SPACING.normal;
  const o = { family, spacing };
  await loadFonts(opts.font);
  // English books are hyphenated, so justified lines don't gape (most of all on phones).
  let hyphenate = null;
  if (/^en\b/i.test(epub.language || 'en')) {
    try {
      const h = await import('hyphen/en-us');
      const fn = (h.default || h).hyphenateSync;
      hyphenate = (t) => fn(t, { minWordLength: 6 });
    } catch (e) {}
  }
  const mx = Math.round(Math.max(18, W * 0.085));
  const mt = Math.round(Math.max(20, H * 0.07));
  const mb = Math.round(Math.max(26, H * 0.085));
  const contentW = W - 2 * mx;
  const bottom = H - mb;
  const frame = makeFrame(contentW);
  const pages = [];
  const chapters = []; // first page index of each spine item
  const anchors = new Map(); // "path#id" → page index
  let page = null;
  let y = 0;
  const newPage = (ch, off) => {
    page = { ch, o: off, lines: [], imgs: [], rules: [] };
    pages.push(page);
    y = mt;
  };
  const empty = () => !page || (!page.lines.length && !page.imgs.length && !page.rules.length);

  try {
    for (let ch = 0; ch < epub.spine.length; ch++) {
      const path = epub.spine[ch].path;
      if (onProgress) onProgress(ch / epub.spine.length);
      await new Promise((r) => setTimeout(r, 0)); // let the screen update between chapters
      let parsed;
      try {
        parsed = chapterBlocks(epub, path, frame, size, hyphenate);
      } catch (e) {
        console.warn('EPUB chapter skipped', path, e);
        parsed = { blocks: [], anchors: new Map() };
      }
      const { blocks } = parsed;
      chapters.push(pages.length);
      if (!blocks.length) {
        anchors.set(path, pages.length);
        continue;
      }
      // A chapter that is only a picture (cover, illustration plates) fills its page.
      const pictureOnly = blocks.every((b) => b.kind === 'img' || b.kind === 'break') && blocks.filter((b) => b.kind === 'img').length === 1;
      const chapterStart = pages.length;
      newPage(ch, 0);
      if (pictureOnly) {
        const img = blocks.find((b) => b.kind === 'img');
        page.full = { path: img.path, w: img.w, h: img.h };
        page.imgs.push({ path: img.path, x: 0, y: 0, w: W, h: H, fit: 1 });
      } else {
        const laid = blocks.map((b) => (b.kind === 'text' ? paraLines(b, o, contentW) : null));
        for (let bi = 0; bi < blocks.length; bi++) {
          const b = blocks[bi];
          if (b.kind === 'break') {
            if (!empty()) newPage(ch, (blocks[bi + 1] && blocks[bi + 1].o) || b.o || page.o);
            continue;
          }
          const gap = empty() ? 0 : b.mt || 0;
          if (b.kind === 'hr') {
            if (y + gap + 2 > bottom) newPage(ch, b.o);
            else y += gap;
            page.rules.push({ x: mx + contentW * 0.4, y: Math.round(y), w: contentW * 0.2 });
            y += 2;
            continue;
          }
          if (b.kind === 'img') {
            const maxH = bottom - mt;
            let w = Math.min(contentW, b.w * 1.5);
            let h = (b.h / b.w) * w;
            if (h > maxH) (h = maxH), (w = (b.w / b.h) * h);
            if (y + gap + h > bottom) {
              const room = bottom - y - gap;
              // Shrink a little to stay with its text, else move to the next page.
              if (room > h * 0.75 && room > maxH * 0.3) (h = room), (w = (b.w / b.h) * h);
              else newPage(ch, b.o);
            }
            if (!empty()) y += gap;
            const x = mx + (b.align === 'left' || b.align === 'start' ? 0 : b.align === 'right' || b.align === 'end' ? contentW - w : (contentW - w) / 2);
            page.imgs.push({ path: b.path, x, y, w, h });
            y += h;
            continue;
          }
          const lines = laid[bi];
          if (!lines.length) continue;
          // Headings stay with the start of what follows them.
          if (b.heading && !empty()) {
            let need = gap;
            for (const l of lines) need += l.h;
            const next = laid[bi + 1];
            if (next && next.length) need += (blocks[bi + 1].mt || 0) + next[0].h + (next[1] ? next[1].h : 0);
            else if (blocks[bi + 1] && blocks[bi + 1].kind === 'img') need += Math.min(bottom - mt, 120);
            if (y + need > bottom) newPage(ch, lines[0].o);
          }
          for (let li = 0; li < lines.length; li++) {
            const l = lines[li];
            let need = l.h + (li === 0 && !empty() ? gap : 0);
            let move = y + need > bottom;
            // No single first line at the foot of a page, no single last line at the top of the next.
            if (!move && li === 0 && lines.length > 1 && y + need + lines[1].h > bottom && !empty()) move = true;
            if (!move && lines.length >= 3 && li === lines.length - 2 && y + need + lines[li + 1].h > bottom && li > 1) move = true;
            if (move && !empty()) {
              newPage(ch, l.o);
              need = l.h;
            } else if (li === 0 && !empty()) y += gap;
            l.y = y;
            page.lines.push(l);
            y += l.h;
          }
        }
      }
      // Anchors inside this chapter: the page each one is on.
      const starts = [];
      for (let p = chapterStart; p < pages.length; p++) starts.push(pages[p].o);
      anchors.set(path, chapterStart);
      for (const [id, off] of parsed.anchors) {
        let p = 0;
        while (p + 1 < starts.length && starts[p + 1] <= off) p++;
        anchors.set(`${path}#${id}`, chapterStart + p);
      }
    }
  } finally {
    frame.remove();
  }
  if (!pages.length) newPage(0, 0);
  if (onProgress) onProgress(1);
  return { W, H, mx, mt, mb, size, family, spacing, pages, chapters, anchors, key: layoutKey(opts) };
}
