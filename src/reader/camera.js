// Zoom + pan over the reading content.
//
// Content coordinates are the stage's own pixels at zoom 1. The camera maps
// them to the screen with translate(tx, ty) scale(s), and keeps a "box" (the
// book or the page strip) on screen: centred when smaller than the view,
// otherwise pannable edge to edge.

export class Camera {
  constructor(el, onChange) {
    this.el = el;
    this.onChange = onChange;
    this.s = 1;
    this.tx = 0;
    this.ty = 0;
    this.W = 0;
    this.H = 0;
    this.box = { x: 0, y: 0, w: 0, h: 0 };
    this.max = 4;
  }

  get zoomed() {
    return this.s > 1.02;
  }

  setView(W, H) {
    this.W = W;
    this.H = H;
  }

  setBox(box) {
    this.box = box;
  }

  clamp(s, tx, ty) {
    const b = this.box;
    const fit = (lo, size, view, t) => {
      const scaled = size * s;
      if (scaled <= view) return (view - scaled) / 2 - lo * s;
      return Math.min(-lo * s, Math.max(view - (lo + size) * s, t));
    };
    return { s, tx: fit(b.x, b.w, this.W, tx), ty: fit(b.y, b.h, this.H, ty) };
  }

  set(s, tx, ty) {
    ({ s, tx, ty } = this.clamp(s, tx, ty));
    const changed = s !== this.s || tx !== this.tx || ty !== this.ty;
    Object.assign(this, { s, tx, ty });
    this.el.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    if (changed) this.onChange?.();
    return changed;
  }

  refresh() {
    this.set(this.s, this.tx, this.ty);
    this.el.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.s})`;
  }

  /** Zoom to `s` keeping the content under view point (px, py) fixed. */
  zoomAround(px, py, s) {
    const c = this.toContent(px, py);
    this.set(s, px - c.x * s, py - c.y * s);
  }

  panBy(dx, dy) {
    return this.set(this.s, this.tx + dx, this.ty + dy);
  }

  toContent(x, y) {
    return { x: (x - this.tx) / this.s, y: (y - this.ty) / this.s };
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  animateTo(s, tx, ty, duration = 320) {
    this.stop();
    const to = this.clamp(s, tx, ty);
    const from = { s: this.s, tx: this.tx, ty: this.ty };
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - start) / duration);
        const e = ease(k);
        // Interpolate through the clamp-free path, then clamp the result.
        this.set(from.s + (to.s - from.s) * e, from.tx + (to.tx - from.tx) * e, from.ty + (to.ty - from.ty) * e);
        if (k < 1) this.raf = requestAnimationFrame(step);
        else {
          this.raf = null;
          resolve();
        }
      };
      this.raf = requestAnimationFrame(step);
    });
  }

  /** Momentum after a pan; velocity in px/ms. */
  fling(vx, vy) {
    this.stop();
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(40, now - last);
      last = now;
      const moved = this.panBy(vx * dt, vy * dt);
      const decay = Math.pow(0.994, dt);
      vx *= decay;
      vy *= decay;
      if (moved && Math.hypot(vx, vy) > 0.02) this.raf = requestAnimationFrame(step);
      else this.raf = null;
    };
    this.raf = requestAnimationFrame(step);
  }
}
