// Small compatibility layer for older browsers (notably iOS 12 / Safari 12).
// Each piece only installs itself when the browser lacks the feature.

// ---------------------------------------------------------------- DOM helpers

for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
  if (!proto.replaceChildren) {
    proto.replaceChildren = function replaceChildren(...nodes) {
      while (this.lastChild) this.removeChild(this.lastChild);
      this.append(...nodes);
    };
  }
}

if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function arrayBuffer() {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(this);
    });
  };
}

// The reader only observes its own full-screen element, so window size changes
// are all that matter.
if (!window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      this.onResize = () => {
        const entries = [...this.targets].map((target) => ({ target, contentRect: target.getBoundingClientRect() }));
        if (entries.length) this.callback(entries, this);
      };
    }
    observe(el) {
      if (!this.targets.size) {
        window.addEventListener('resize', this.onResize);
        window.addEventListener('orientationchange', this.onResize);
      }
      this.targets.add(el);
      requestAnimationFrame(this.onResize);
    }
    unobserve(el) {
      this.targets.delete(el);
    }
    disconnect() {
      this.targets.clear();
      window.removeEventListener('resize', this.onResize);
      window.removeEventListener('orientationchange', this.onResize);
    }
  };
}

// ---------------------------------------------------------------- pointer events
//
// Safari before 13 has no Pointer Events. Translate touch and mouse events into
// pointerdown / pointermove / pointerup / pointercancel carrying the fields the
// app uses (pointerId, clientX/Y, button, pointerType), dispatched on the
// element under the finger so they bubble like the real thing.
//
// iOS 12 also ignores `touch-action: none` and `user-scalable=no`, so inside the
// reader the shim stops the page itself from scrolling, pinch-zooming or
// double-tap-zooming (the reader handles those gestures itself).

const NO_NATIVE_GESTURES = '.reader';
const NATIVE_SCROLL_OK = '.ts-track, .word-pop';

export function installPointerShim(force = false) {
  if (window.PointerEvent && !force) return;
  const targets = new Map(); // pointerId → element the gesture started on
  let lastTouch = 0;
  let lastTouchEnd = 0;

  const fire = (type, target, src, id, pointerType) => {
    const ev = document.createEvent('Event');
    ev.initEvent(type, true, true);
    ev.pointerId = id;
    ev.pointerType = pointerType;
    ev.isPrimary = id === 1 || targets.size <= 1;
    ev.clientX = src.clientX;
    ev.clientY = src.clientY;
    ev.pageX = src.pageX;
    ev.pageY = src.pageY;
    ev.button = pointerType === 'mouse' ? src.button : 0;
    ev.buttons = pointerType === 'mouse' ? src.buttons : 1;
    (target && target.isConnected ? target : document).dispatchEvent(ev);
    return ev;
  };

  const inReader = (el) => el && el.closest && el.closest(NO_NATIVE_GESTURES) && !el.closest(NATIVE_SCROLL_OK);
  const touchId = (t) => 1000 + t.identifier;

  // Touch events keep going to the element the finger first landed on, even
  // if the app removes that element mid-gesture (the reader swaps pages during
  // a turn) — and a removed element no longer bubbles anything to the
  // document. So move/end are listened for on that element itself.
  const onMove = (e) => {
    lastTouch = Date.now();
    let block = false;
    for (const t of e.changedTouches) {
      if (!targets.has(touchId(t))) continue;
      const target = targets.get(touchId(t));
      if (inReader(target)) block = true;
      fire('pointermove', target, t, touchId(t), 'touch');
    }
    if (block || e.touches.length > 1) e.preventDefault(); // no page scroll / pinch-zoom in the reader
  };

  document.addEventListener(
    'touchstart',
    (e) => {
      lastTouch = Date.now();
      const el = e.target;
      if (!el.__pointerShim) {
        el.__pointerShim = true;
        el.addEventListener('touchmove', onMove, { passive: false });
        el.addEventListener('touchend', onEnd, { passive: false });
        el.addEventListener('touchcancel', onCancel, { passive: false });
      }
      for (const t of e.changedTouches) {
        targets.set(touchId(t), el);
        fire('pointerdown', el, t, touchId(t), 'touch');
      }
    },
    { capture: true, passive: false },
  );

  const end = (type) => (e) => {
    lastTouch = Date.now();
    for (const t of e.changedTouches) {
      if (!targets.has(touchId(t))) continue;
      const target = targets.get(touchId(t));
      targets.delete(touchId(t));
      fire(type, target, t, touchId(t), 'touch');
      // A second quick tap would make iOS 12 zoom the page; the reader uses double-tap itself.
      if (type === 'pointerup' && inReader(target) && !target.closest('button, a, input, select')) {
        const now = Date.now();
        if (now - lastTouchEnd < 350) e.preventDefault();
        lastTouchEnd = now;
      }
    }
  };
  const onEnd = end('pointerup');
  const onCancel = end('pointercancel');

  // Native pinch-zoom of the whole page (iOS gesture events).
  for (const g of ['gesturestart', 'gesturechange']) {
    document.addEventListener(g, (e) => inReader(e.target) && e.preventDefault(), { passive: false });
  }

  // Mouse, for desktop browsers without Pointer Events. Ignore the mouse events
  // that mobile browsers synthesise right after a touch.
  let mouseTarget = null;
  const fromMouse = () => Date.now() - lastTouch > 800;
  document.addEventListener('mousedown', (e) => {
    if (!fromMouse()) return;
    mouseTarget = e.target;
    fire('pointerdown', e.target, e, 1, 'mouse');
  }, true);
  document.addEventListener('mousemove', (e) => {
    if (fromMouse()) fire('pointermove', mouseTarget || e.target, e, 1, 'mouse');
  }, true);
  document.addEventListener('mouseup', (e) => {
    if (!fromMouse()) return;
    fire('pointerup', mouseTarget || e.target, e, 1, 'mouse');
    mouseTarget = null;
  }, true);
}

installPointerShim(location.search.includes('pointer-shim'));

// ---------------------------------------------------------------- iOS page zoom guard
// In Safari (outside the home-screen app) iOS can still pinch- or double-tap-
// zoom the whole page, even with touch-action / user-scalable set. A zoomed or
// shifted page moves everything the reader draws on top of the text (word
// highlights, the translation bubble, read-aloud selection). Inside the
// reader, block those native gestures — the reader has its own zoom.
(function installZoomGuard() {
  const inReader = (el) => el && el.closest && el.closest('.reader') && !el.closest('.ts-track, .word-pop');
  for (const g of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(g, (e) => inReader(e.target) && e.preventDefault(), { passive: false });
  }
  let lastEnd = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      if (!inReader(e.target) || e.target.closest('button, a, input, select, label')) return;
      const now = Date.now();
      if (now - lastEnd < 350 && e.cancelable) e.preventDefault(); // second tap of a double-tap
      lastEnd = now;
    },
    { passive: false },
  );
})();

// ---------------------------------------------------------------- CSS feature flags
// Flexbox `gap` (Safari 14.1+) can't be feature-queried in CSS; detect it here
// so the stylesheet can add margins instead.
(function detectFlexGap() {
  const d = document.createElement('div');
  d.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
  d.appendChild(document.createElement('div'));
  d.appendChild(document.createElement('div'));
  document.documentElement.appendChild(d);
  const ok = d.scrollHeight === 1;
  d.remove();
  if (!ok) document.documentElement.classList.add('no-flexgap');
})();
