// Page-turn animation: a 3D "leaf" hinged at the spine (double mode) or the
// binding edge (single mode) that follows the finger, with light falloff on
// both faces, a cast shadow on the page being uncovered, and a slight lift
// toward the corner being held.
//
// The flipper only animates. The reader decides what is on each face/slot.

const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
};

export class Flipper {
  /**
   * @param {object} o
   * @param {HTMLElement} o.book  element the leaf lives in
   * @param {'single'|'double'} o.mode
   * @param {1|-1} o.dir          +1 forward, -1 backward
   * @param {number} o.pw o.ph    page size in CSS px
   * @param {HTMLElement} o.front o.back  page elements for the two faces (back may be blank paper)
   * @param {(t:number)=>void} o.onProgress  called every frame (book offset, etc.)
   */
  constructor(o) {
    Object.assign(this, o);
    this.t = 0;
    this.tilt = 0;
    const leaf = (this.leaf = document.createElement('div'));
    leaf.className = 'leaf';
    const hingeLeft = this.mode === 'single' || this.dir > 0;
    leaf.style.width = `${this.pw}px`;
    leaf.style.height = `${this.ph}px`;
    leaf.style.left = this.mode === 'double' && this.dir > 0 ? `${this.pw}px` : '0px';
    leaf.style.transformOrigin = hingeLeft ? '0% 50%' : '100% 50%';
    leaf.dataset.hinge = hingeLeft ? 'left' : 'right';
    this.frontFace = face('front', this.front);
    this.backFace = face('back', this.back);
    leaf.append(this.frontFace, this.backFace);

    // Shadow the leaf casts on the page it uncovers.
    const cast = (this.cast = document.createElement('div'));
    cast.className = 'cast-shadow';
    cast.dataset.side = hingeLeft ? 'right-of-hinge' : 'left-of-hinge';
    cast.style.width = `${this.pw}px`;
    cast.style.height = `${this.ph}px`;
    cast.style.left = leaf.style.left;
    this.book.append(cast, leaf);
    this.set(this.reverse ? 0 : 0);
  }

  /** Map progress t∈[0,1] to the leaf's pose. */
  set(t, tilt = this.tilt) {
    this.t = t = Math.min(1, Math.max(0, t));
    this.tilt = tilt;
    // Single-mode backward turns replay a forward turn in reverse.
    const a = this.mode === 'single' && this.dir < 0 ? 1 - t : t;
    const hingeLeft = this.leaf.dataset.hinge === 'left';
    const deg = (hingeLeft ? -180 : 180) * a;
    const lift = Math.sin(Math.PI * a);
    // Lift in the parent's space (before rotating) so the leaf never sinks behind the pages at 180°.
    this.leaf.style.transform = `translateZ(2px) rotateY(${deg}deg) rotateZ(${tilt * lift}deg)`;
    // Light: the front darkens as it turns away, the back brightens as it lands.
    this.frontFace.style.setProperty('--shade', (Math.min(a, 0.5) * 2 * 0.55).toFixed(3));
    this.backFace.style.setProperty('--shade', (Math.max(0, 1 - a) * 0.6).toFixed(3));
    this.leaf.style.setProperty('--lift', lift.toFixed(3));
    this.cast.style.opacity = (lift * 0.75).toFixed(3);
    this.cast.style.setProperty('--reach', `${(1 - a) * 100}%`);
    this.onProgress?.(t);
  }

  /** Progress from a finger x (book-local coords). */
  progressFromX(x, startX) {
    const { pw } = this;
    if (this.mode === 'double') {
      const spine = pw;
      const c = this.dir > 0 ? (x - spine) / pw : (spine - x) / pw;
      return Math.acos(Math.max(-1, Math.min(1, c))) / Math.PI;
    }
    if (this.dir > 0) return Math.acos(Math.max(-1, Math.min(1, x / pw))) / Math.PI;
    return Math.max(0, Math.min(1, (x - startX) / (pw * 0.85)));
  }

  animateTo(target, duration) {
    const from = this.t;
    const dist = Math.abs(target - from);
    duration ??= 200 + 520 * dist;
    const curve = dist > 0.95 ? ease.inOut : ease.out;
    cancelAnimationFrame(this.raf);
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - start) / duration);
        this.set(from + (target - from) * curve(k));
        if (k < 1) this.raf = requestAnimationFrame(step);
        else resolve();
      };
      this.raf = requestAnimationFrame(step);
    });
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.leaf.remove();
    this.cast.remove();
  }
}

function face(kind, content) {
  const f = document.createElement('div');
  f.className = `face ${kind}`;
  if (content) f.append(content);
  else f.classList.add('paper-back');
  const shade = document.createElement('div');
  shade.className = 'shade';
  f.append(shade);
  return f;
}
