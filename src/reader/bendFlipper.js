// "Soft page" turn: the sheet bends as it turns. The leaf is cut into narrow
// vertical strips chained edge to edge, each rotated a little relative to the
// previous one, so the page forms a smooth curve — the part near the spine
// leads, the free edge trails behind. Each strip is lit by its own angle, which
// gives the curved highlight-and-shadow look of real paper.
//
// Same interface as Flipper: set(t), progressFromX(), animateTo(), destroy(), t.

const N = 24; // strips
const BEND = 115; // max total bend across the sheet, degrees

const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
};

export class BendFlipper {
  constructor({ book, dir, pw, ph, front, back, onProgress }) {
    Object.assign(this, { book, dir, pw, ph, onProgress });
    this.t = 0;
    this.tilt = 0;
    const w = pw / N;
    this.w = w;
    const hingeLeft = dir > 0; // forward turns hinge on the spine at the right page's left edge

    const leaf = (this.leaf = document.createElement('div'));
    leaf.className = 'bend-leaf';
    Object.assign(leaf.style, { left: `${dir > 0 ? pw : 0}px`, width: `${pw}px`, height: `${ph}px` });

    // Shadow cast on the page being uncovered.
    const cast = (this.cast = document.createElement('div'));
    cast.className = 'cast-shadow';
    cast.dataset.side = hingeLeft ? 'right-of-hinge' : 'left-of-hinge';
    Object.assign(cast.style, { width: `${pw}px`, height: `${ph}px`, left: leaf.style.left });

    // Strip i sits at distance i·w from the spine. Strips nest so rotations accumulate.
    this.strips = [];
    let parent = leaf;
    for (let i = 0; i < N; i++) {
      const s = document.createElement('div');
      s.className = 'bend-strip';
      // Slight overlap hides hairline seams between strips.
      s.style.width = `${w + 0.5}px`;
      s.style.height = `${ph}px`;
      if (i === 0) s.style[hingeLeft ? 'left' : 'right'] = '0px';
      else s.style[hingeLeft ? 'left' : 'right'] = `${w}px`;
      s.style.transformOrigin = hingeLeft ? '0 50%' : '100% 50%';
      const f = document.createElement('canvas');
      f.className = 'bend-face front';
      const b = document.createElement('canvas');
      b.className = 'bend-face back';
      const fs = document.createElement('i');
      fs.className = 'bend-shade front';
      const bs = document.createElement('i');
      bs.className = 'bend-shade back';
      s.append(f, fs, b, bs);
      parent.append(s);
      parent = s;
      this.strips.push({ el: s, f, b, fs, bs });
    }
    book.append(cast, leaf);

    // Slice the page images into the strips once they are painted.
    this.#slice(front, 'f', (i) => (hingeLeft ? i : N - 1 - i));
    this.#slice(back, 'b', (i) => (hingeLeft ? N - 1 - i : i));
    this.set(0);
  }

  async #slice(pageEl, key, sliceIndex) {
    const strips = this.strips;
    if (!pageEl) {
      for (const s of strips) s[key].classList.add('blank');
      return;
    }
    await pageEl.painted;
    const src = pageEl.querySelector('canvas');
    if (!src || !src.width) return;
    const sw = src.width / N;
    for (let i = 0; i < N; i++) {
      const c = strips[i][key];
      const k = sliceIndex(i);
      c.width = Math.ceil(sw) + 1;
      c.height = src.height;
      c.getContext('2d').drawImage(src, Math.floor(k * sw), 0, Math.ceil(sw) + 1, src.height, 0, 0, c.width, c.height);
    }
  }

  /** Pose for progress t∈[0,1]. */
  set(t, tilt = this.tilt) {
    this.t = t = Math.min(1, Math.max(0, t));
    this.tilt = tilt;
    const sign = this.dir > 0 ? -1 : 1;
    // The spine edge leads; the bend fades in and out over the turn and never
    // lets the free edge dip below the book.
    const lead = 180 * t;
    const bend = Math.min(BEND * Math.sin(Math.PI * t), lead * 0.8);
    const per = bend / (N - 1);
    const lift = Math.sin(Math.PI * t);
    let abs = 0;
    for (let i = 0; i < N; i++) {
      const s = this.strips[i];
      const rel = i === 0 ? lead : -per; // degrees in the turning direction
      abs += rel;
      const extra = i === 0 ? ` rotateZ(${tilt * lift}deg)` : '';
      s.el.style.transform = `rotateY(${sign * rel}deg)${extra}`;
      // Lambert-ish lighting from the viewer: brightness ~ |cos(angle)|.
      const c = Math.cos((abs * Math.PI) / 180);
      const nextC = Math.cos(((abs - per) * Math.PI) / 180);
      const front = (x) => Math.max(0, Math.min(0.75, (1 - x) * 0.7));
      const back = (x) => Math.max(0, Math.min(0.75, (1 + x) * 0.7));
      // Gradient across each strip so the shading is smooth, not banded.
      const dirGrad = this.dir > 0 ? 'to right' : 'to left';
      s.fs.style.background = `linear-gradient(${dirGrad}, rgba(0,0,0,${front(c).toFixed(3)}), rgba(0,0,0,${front(nextC).toFixed(3)}))`;
      s.bs.style.background = `linear-gradient(${dirGrad === 'to right' ? 'to left' : 'to right'}, rgba(0,0,0,${back(c).toFixed(3)}), rgba(0,0,0,${back(nextC).toFixed(3)}))`;
    }
    this.cast.style.opacity = (lift * 0.7).toFixed(3);
    this.cast.style.setProperty('--reach', `${(1 - t) * 100}%`);
    this.onProgress?.(t);
  }

  progressFromX(x) {
    const { pw } = this;
    const c = this.dir > 0 ? (x - pw) / pw : (pw - x) / pw;
    return Math.acos(Math.max(-1, Math.min(1, c))) / Math.PI;
  }

  animateTo(target, duration) {
    const from = this.t;
    const dist = Math.abs(target - from);
    duration ??= 220 + 560 * dist;
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
