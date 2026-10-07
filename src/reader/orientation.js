// Orientation lock.
//
// Where the platform allows it (Android, installed app / fullscreen) we use
// the Screen Orientation API. iPadOS Safari has no such API, so there we keep
// the layout fixed and counter-rotate the reader with CSS whenever the device
// turns, so the book stays put relative to the hardware.

const angleNow = () => {
  const a = screen.orientation?.angle ?? window.orientation ?? 0;
  return ((a % 360) + 360) % 360;
};

export class OrientationLock {
  constructor(el, onChange) {
    this.el = el;
    this.onChange = onChange;
    this.locked = false;
    this.lockedMode = null;
    this.rotation = 0; // CSS rotation applied to the reader, degrees
    this.handler = () => this.#apply();
    window.addEventListener('resize', this.handler);
    screen.orientation?.addEventListener?.('change', this.handler);
  }

  async toggle(mode) {
    if (this.locked) {
      this.locked = false;
      this.native = false;
      try {
        screen.orientation?.unlock?.();
      } catch {}
      this.#apply();
      return false;
    }
    this.locked = true;
    this.lockedMode = mode;
    this.lockedAngle = angleNow();
    this.native = false;
    try {
      await screen.orientation.lock(mode === 'double' ? 'landscape' : 'portrait');
      this.native = true;
    } catch {}
    this.#apply();
    return true;
  }

  #apply() {
    const s = this.el.style;
    let rot = 0;
    if (this.locked && !this.native) {
      const portrait = innerHeight > innerWidth;
      const wantPortrait = this.lockedMode !== 'double';
      if (portrait !== wantPortrait) {
        // Device turned 90° away from the locked orientation.
        const delta = (angleNow() - this.lockedAngle + 360) % 360;
        rot = delta === 270 ? 90 : -90;
      }
    }
    this.rotation = rot;
    if (rot) {
      Object.assign(s, {
        position: 'fixed',
        width: `${innerHeight}px`,
        height: `${innerWidth}px`,
        left: `${(innerWidth - innerHeight) / 2}px`,
        top: `${(innerHeight - innerWidth) / 2}px`,
        transform: `rotate(${rot}deg)`,
      });
    } else {
      for (const k of ['position', 'width', 'height', 'left', 'top', 'transform']) s[k] = '';
    }
    this.onChange();
  }

  /** Viewport point → reader-local point. */
  toLocal(x, y) {
    // Measure where the reader really is: on iOS the visual viewport can be
    // shifted (page zoom, address bar, scroll), so it isn't always at 0,0.
    const box = this.el.getBoundingClientRect();
    if (!this.rotation) return { x: x - box.left, y: y - box.top };
    const W = this.el.offsetWidth;
    const H = this.el.offsetHeight;
    const vx = x - (box.left + box.width / 2);
    const vy = y - (box.top + box.height / 2);
    const r = (-this.rotation * Math.PI) / 180;
    return {
      x: vx * Math.cos(r) - vy * Math.sin(r) + W / 2,
      y: vx * Math.sin(r) + vy * Math.cos(r) + H / 2,
    };
  }

  /** Viewport DOMRect → reader-local rect. */
  rectToLocal(rect) {
    const a = this.toLocal(rect.left, rect.top);
    const b = this.toLocal(rect.right, rect.bottom);
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    return { left, top, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  }

  destroy() {
    window.removeEventListener('resize', this.handler);
    screen.orientation?.removeEventListener?.('change', this.handler);
    if (this.locked && this.native) {
      try {
        screen.orientation.unlock();
      } catch {}
    }
  }
}
