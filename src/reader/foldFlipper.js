// "Paper corner" page turn: the page is peeled from a corner along a straight
// fold line that follows the finger. The folded flap shows the back of the
// sheet (the next page), with shading along the fold and a shadow on the page
// being uncovered — like folding a real sheet of paper.
//
// Geometry is done in a "frame" where the turning page always sits on the
// right half [pw, 2pw]; backward turns are mirrored into that frame.
//
// Same interface as Flipper: set(t), follow(x, y, x0, y0), animateTo(), destroy(), t.

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Affine helpers: [a, b, c, d, e, f] maps (x, y) → (a x + c y + e, b x + d y + f)
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/** Reflection across the line through p with unit direction u. */
function reflection(p, u) {
  const a = 2 * u.x * u.x - 1;
  const b = 2 * u.x * u.y;
  const d = 2 * u.y * u.y - 1;
  return [a, b, b, d, p.x - a * p.x - b * p.y, p.y - b * p.x - d * p.y];
}

/** Keep the part of convex polygon `poly` where (P - m)·n <= 0. */
function clipHalf(poly, m, n) {
  const side = (p) => (p.x - m.x) * n.x + (p.y - m.y) * n.y;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if (sa * sb < 0) {
      const k = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
    }
  }
  return out;
}

function el(cls, css) {
  const e = document.createElement('div');
  e.className = cls;
  if (css) e.style.cssText = css;
  return e;
}

export class FoldFlipper {
  constructor({ book, dir, pw, ph, front, back, onProgress }) {
    Object.assign(this, { book, dir, pw, ph, onProgress });
    this.t = 0;
    const W = pw * 2;
    // Mirror between frame and book coordinates for backward turns.
    this.mirror = dir > 0 ? [1, 0, 0, 1, 0, 0] : [-1, 0, 0, 1, W, 0];

    const root = (this.root = el('fold', `width:${W}px;height:${ph}px`));

    // The page being turned, minus the part that is folded over.
    this.frontClip = el('fold-clip');
    const fw = el('fold-page', `left:${dir > 0 ? pw : 0}px;width:${pw}px;height:${ph}px`);
    fw.append(front || el('page paper-blank'));
    this.frontClip.append(fw);

    // Shadow the lifted sheet casts on the page being uncovered.
    this.underClip = el('fold-clip', `clip-path: inset(0 ${dir > 0 ? 0 : pw}px 0 ${dir > 0 ? pw : 0}px)`);
    this.underShadow = el('fold-strip under');
    this.underClip.append(this.underShadow);

    // The folded flap: back of the sheet, reflected over the fold line.
    this.flapWrap = el('fold-flap-wrap');
    this.flapClip = el('fold-clip');
    this.backPage = el('fold-page', `left:0;top:0;width:${pw}px;height:${ph}px;transform-origin:0 0`);
    this.backPage.append(back || el('page paper-blank'));
    this.flapShade = el('fold-strip flap');
    this.flapClip.append(this.backPage, this.flapShade);
    this.flapWrap.append(this.flapClip);

    root.append(this.frontClip, this.underClip, this.flapWrap);
    book.append(root);
    this.corner = { x: W, y: ph };
    this.F = { ...this.corner };
    this.#draw();
  }

  /** Programmatic pose for progress t (corner travels across with a gentle lift). */
  set(t) {
    this.corner = { x: this.pw * 2, y: this.ph };
    const lift = Math.sin(Math.PI * t) * this.ph * 0.14;
    this.F = { x: this.pw * 2 * (1 - t), y: this.ph - lift };
    this.#draw();
  }

  /** Follow a finger at book-local (x, y); (x0, y0) is where the drag began. */
  follow(x, y, x0, y0) {
    const toFrame = (p) => apply(this.mirror, p); // mirror is its own inverse
    const p = toFrame({ x, y });
    const s = toFrame({ x: x0, y: y0 });
    if (!this.grabbed) {
      this.grabbed = true;
      this.corner = { x: this.pw * 2, y: s.y < this.ph / 2 ? 0 : this.ph };
      this.grabOffset = { x: this.corner.x - s.x, y: this.corner.y - s.y };
    }
    this.F = { x: p.x + this.grabOffset.x, y: p.y + this.grabOffset.y };
    this.#draw();
  }

  /** Keep the sheet attached at the spine: the corner can't travel further than the paper allows. */
  #constrain() {
    const { pw, ph } = this;
    const c = this.corner;
    const near = { x: pw, y: c.y }; // spine end on the corner's edge
    const far = { x: pw, y: ph - c.y }; // opposite spine end
    let F = this.F;
    const lim = (center, r) => {
      const dx = F.x - center.x;
      const dy = F.y - center.y;
      const d = Math.hypot(dx, dy);
      if (d > r) F = { x: center.x + (dx / d) * r, y: center.y + (dy / d) * r };
    };
    lim(near, pw);
    lim(far, Math.hypot(pw, ph));
    // Don't let the corner wander off the page's own edge line.
    F = { x: Math.min(F.x, pw * 2), y: F.y };
    this.F = F;
  }

  #draw() {
    this.#constrain();
    const { pw, ph } = this;
    const C = this.corner;
    const F = this.F;
    const dist = Math.hypot(C.x - F.x, C.y - F.y);
    this.t = Math.max(0, Math.min(1, (C.x - F.x) / (2 * pw)));
    this.onProgress?.(this.t);

    const toBook = (p) => apply(this.mirror, p);
    const poly = (pts) => `polygon(${pts.map((p) => toBook(p)).map((p) => `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px`).join(',')})`;
    const page = [
      { x: pw, y: 0 },
      { x: 2 * pw, y: 0 },
      { x: 2 * pw, y: ph },
      { x: pw, y: ph },
    ];

    if (dist < 0.5) {
      this.frontClip.style.clipPath = 'none';
      this.flapWrap.style.display = 'none';
      this.underClip.style.display = 'none';
      return;
    }
    this.flapWrap.style.display = '';
    this.underClip.style.display = '';

    const m = { x: (C.x + F.x) / 2, y: (C.y + F.y) / 2 };
    const n = { x: (C.x - F.x) / dist, y: (C.y - F.y) / dist }; // points toward the corner
    const u = { x: -n.y, y: n.x }; // along the fold

    // Visible front: page on the spine side of the fold.
    const front = clipHalf(page, m, n);
    this.frontClip.style.clipPath = front.length > 2 ? poly(front) : 'polygon(0 0)';

    // Flap: the corner side of the page, reflected over the fold line.
    const flip = clipHalf(page, m, { x: -n.x, y: -n.y });
    const R = reflection(m, u);
    const flap = flip.map((p) => apply(R, p));
    this.flapClip.style.clipPath = flap.length > 2 ? poly(flap) : 'polygon(0 0)';

    // Back page sits where it will land (left half), carried by fold∘(turn about the spine).
    const S = [-1, 0, 0, 1, 2 * pw, 0];
    const T = mul(this.mirror, mul(R, mul(S, this.mirror)));
    // In book coords the back page's home is the opposite half of the turning page.
    const home = this.dir > 0 ? 0 : pw;
    const M = mul(T, [1, 0, 0, 1, home, 0]);
    this.backPage.style.transform = `matrix(${M.map((v) => v.toFixed(5)).join(',')})`;

    // Shading strips anchored on the fold line (in book coordinates).
    const mb = toBook(m);
    const ub = { x: u.x * this.mirror[0], y: u.y };
    const nb = { x: n.x * this.mirror[0], y: n.y };
    const angle = Math.atan2(ub.y, ub.x);
    const fade = Math.min(1, dist / (pw * 0.12)) * Math.min(1, (1 - this.t) / 0.12);
    const reach = Math.min(dist * 0.5, pw * 0.35) + 8;
    const len = Math.hypot(2 * pw, ph) * 2;
    // Local +y of a strip rotated by `angle` points along (-ub.y, ub.x); flip it toward the side we want.
    const towardCorner = -ub.y * nb.x + ub.x * nb.y > 0 ? 1 : -1;
    const place = (strip, side, h) => {
      // side: +1 toward the corner side of the fold, -1 toward the spine side
      const s = side * towardCorner;
      strip.style.width = `${len}px`;
      strip.style.height = `${h}px`;
      strip.style.left = `${mb.x - len / 2}px`;
      strip.style.top = `${s > 0 ? mb.y : mb.y - h}px`;
      strip.style.transformOrigin = `50% ${s > 0 ? 0 : h}px`;
      strip.style.transform = `rotate(${angle}rad)`;
      strip.dataset.dir = s > 0 ? 'down' : 'up';
    };
    place(this.underShadow, 1, reach);
    this.underShadow.style.opacity = fade.toFixed(3);
    place(this.flapShade, -1, Math.min(dist * 0.5, pw * 0.5) + 4);
    this.flapShade.style.opacity = fade.toFixed(3);
    this.flapWrap.style.setProperty('--fold-shadow', (0.45 * fade).toFixed(3));
  }

  animateTo(target, duration) {
    const W = this.pw * 2;
    const from = { ...this.F };
    const C = this.corner;
    const to = target >= 1 ? { x: C.x - W, y: C.y } : { ...C };
    const span = Math.abs(to.x - from.x) / W;
    duration ??= 220 + 560 * span;
    const lift = (C.y > this.ph / 2 ? -1 : 1) * this.ph * 0.07 * span;
    cancelAnimationFrame(this.raf);
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - start) / duration);
        const e = ease(k);
        this.F = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e + lift * Math.sin(Math.PI * e) };
        this.#draw();
        if (k < 1) this.raf = requestAnimationFrame(step);
        else resolve();
      };
      this.raf = requestAnimationFrame(step);
    });
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.root.remove();
  }
}
