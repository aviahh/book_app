// Page tones (Warm / Night) that recolour the page but leave pictures alone.
//
// The page is rendered normally, then:
//  1. the page's drawing instructions are scanned to find where images are
//     drawn (same operator codes in PDF.js 2.16 and 6),
//  2. the whole canvas is recoloured with GPU blend modes (no pixel loops),
//  3. the untouched image areas are copied back on top.
// A page that is one big image is checked by colour: a scanned page of text
// (mostly white, colourless) gets the tone like any text page; an illustration
// keeps its colours.

const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  beginGroup: 76,
  endGroup: 77,
  paintJpegXObject: 82,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87,
  paintImageXObjectRepeat: 88,
};

const TONES = {
  // multiply = tint paper and ink; invert + multiply + screen = light ink on dark paper
  warm: { multiply: '#f6ead3' },
  night: { invert: true, multiply: '#d9d1c3', screen: '#1d1b18', dimImages: 0.12 },
};

export const PAGE_BACKGROUND = { original: '#ffffff', warm: '#f6ead3', night: '#1d1b18' };

// a ∘ b : apply b first, then a
const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/** Image placements of a page, as transforms of the unit square in PDF space (cached per page). */
const placementCache = new WeakMap();
async function imagePlacements(page) {
  if (placementCache.has(page)) return placementCache.get(page);
  const promise = page.getOperatorList().then(({ fnArray, argsArray }) => {
    const out = [];
    const stack = [];
    let m = [1, 0, 0, 1, 0, 0];
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = argsArray[i];
      switch (fn) {
        case OPS.save:
          stack.push(m);
          break;
        case OPS.restore:
          m = stack.pop() || m;
          break;
        case OPS.transform:
          m = mul(m, args);
          break;
        case OPS.paintFormXObjectBegin:
        case OPS.beginGroup: {
          stack.push(m);
          const matrix = fn === OPS.beginGroup ? args && args[0] && args[0].matrix : args && args[0];
          if (Array.isArray(matrix) || ArrayBuffer.isView(matrix)) m = mul(m, Array.from(matrix));
          break;
        }
        case OPS.paintFormXObjectEnd:
        case OPS.endGroup:
          m = stack.pop() || m;
          break;
        case OPS.paintImageXObject:
        case OPS.paintInlineImageXObject:
        case OPS.paintJpegXObject:
          out.push(m);
          break;
        case OPS.paintImageXObjectRepeat: {
          // [objId, scaleX, scaleY, positions]
          const [, sx, sy, pos] = args;
          for (let k = 0; k + 1 < pos.length; k += 2) out.push(mul(m, [sx, 0, 0, sy, pos[k], pos[k + 1]]));
          break;
        }
        case OPS.paintInlineImageXObjectGroup: {
          // [imgData, map] where each map entry carries its own transform
          for (const e of args[1] || []) if (e && e.transform) out.push(mul(m, e.transform));
          break;
        }
      }
    }
    return out;
  });
  placementCache.set(page, promise);
  return promise;
}

/** Axis-aligned canvas-pixel rectangles of the page's images. */
async function imageRects(page, viewport, W, H) {
  const placements = await imagePlacements(page);
  const rects = [];
  for (const p of placements) {
    const t = mul(viewport.transform, p);
    const xs = [t[4], t[0] + t[4], t[2] + t[4], t[0] + t[2] + t[4]];
    const ys = [t[5], t[1] + t[5], t[3] + t[5], t[1] + t[3] + t[5]];
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const x1 = Math.min(W, Math.ceil(Math.max(...xs)));
    const y1 = Math.min(H, Math.ceil(Math.max(...ys)));
    if (x1 - x0 >= 4 && y1 - y0 >= 4) rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return rects;
}

/** Is this image region a scanned page of text (mostly white paper, no colour)? */
function looksLikeScannedText(canvas, r) {
  const S = 48;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, S, S);
  const d = ctx.getImageData(0, 0, S, S).data;
  let white = 0;
  let sat = 0;
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    const mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mx > 205) white++;
    sat += mx ? (mx - mn) / mx : 0;
  }
  c.width = c.height = 0;
  const n = d.length / 4;
  return white / n > 0.55 && sat / n < 0.12;
}

/** Recolour a freshly rendered page canvas in place, keeping its pictures as they are. */
export async function applyTone(canvas, page, viewport, tone) {
  const t = TONES[tone];
  if (!t) return;
  const W = canvas.width;
  const H = canvas.height;
  let rects = [];
  try {
    rects = await imageRects(page, viewport, W, H);
  } catch {}
  // A page-sized image that is really a scan of text should be toned like text.
  rects = rects.filter((r) => !(r.w * r.h > W * H * 0.6 && looksLikeScannedText(canvas, r)));

  // Keep a copy of every picture before recolouring.
  const kept = rects.map((r) => {
    const c = document.createElement('canvas');
    c.width = r.w;
    c.height = r.h;
    c.getContext('2d').drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return [r, c];
  });

  const ctx = canvas.getContext('2d');
  ctx.save();
  if (t.invert) {
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }
  if (t.multiply) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = t.multiply;
    ctx.fillRect(0, 0, W, H);
  }
  if (t.screen) {
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = t.screen;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();

  for (const [r, c] of kept) {
    ctx.drawImage(c, r.x, r.y);
    if (t.dimImages) {
      // a little softer, so pictures don't glare on a dark page
      ctx.fillStyle = `rgba(0,0,0,${t.dimImages})`;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    c.width = c.height = 0;
  }
}
