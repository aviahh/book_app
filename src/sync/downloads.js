// Downloads that take a while (books from Drive or a family library): a card
// with the progress that can be hidden (it shrinks to a small pill in the
// corner, which stays while you use the app; tap it to see the card again)
// or cancelled. Before a big download, a check that the device has room.

import { nav } from '../router.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${Math.round(n / 1048576)} MB`);

export class Cancelled extends Error {}

/** A cancel switch handed to the download itself: ctl.onCancel(fn), ctl.cancelled. */
export function control() {
  const hooks = [];
  return {
    cancelled: false,
    onCancel(fn) {
      if (this.cancelled) fn();
      else hooks.push(fn);
    },
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      for (const fn of hooks) {
        try {
          fn();
        } catch (e) {}
      }
    },
  };
}

/** Is there room for `size` bytes? Asks first when it looks tight. Returns whether to go ahead. */
export async function roomFor(size) {
  if (!size) return true;
  try {
    const est = navigator.storage && navigator.storage.estimate && (await navigator.storage.estimate());
    if (!est || !est.quota) return true;
    const free = est.quota - (est.usage || 0);
    // The book is stored once, and briefly held in memory while it's added.
    if (free > size * 1.5) return true;
    return confirm(`This book is about ${mb(size)}, and Folio has only about ${mb(Math.max(0, free))} of space left on this device. Download it anyway?`);
  } catch (e) {
    return true;
  }
}

/**
 * Run a download with its card. run(onProgress, ctl) → the local book.
 * Resolves { book, hidden } (hidden: the card had been put away, so don't
 * jump into the book), or null if cancelled. Errors are passed on.
 */
export async function withProgress({ title, from, size }, run) {
  if (!(await roomFor(size))) return null;
  const ctl = control();
  let hidden = false;
  let fraction = 0;
  const card = document.createElement('div');
  card.className = 'import-overlay dl-overlay';
  card.innerHTML = `
    <div class="import-card" role="dialog" aria-label="Downloading">
      <div class="spinner"></div>
      <p class="import-title">Downloading from ${esc(from)}</p>
      <p class="import-name">${esc(title)}${size ? ' · ' + mb(size) : ''}</p>
      <div class="sync-bar"><i></i></div>
      <p class="dl-pct">0%</p>
      <div class="dl-btns"><button class="btn subtle" data-dl="hide">Hide</button><button class="btn subtle" data-dl="cancel">Cancel</button></div>
    </div>`;
  const pill = document.createElement('button');
  pill.className = 'dl-pill';
  pill.hidden = true;
  pill.setAttribute('aria-label', 'Show download');
  document.body.append(card, pill);
  const draw = () => {
    const pct = `${Math.round(fraction * 100)}%`;
    card.querySelector('.sync-bar i').style.width = pct;
    card.querySelector('.dl-pct').textContent = pct;
    if (!pill.dataset.done) pill.innerHTML = `<span class="dl-pill-text">${esc(title)}</span><span class="dl-pill-pct">${pct}</span><i class="dl-pill-bar" style="width:${pct}"></i>`;
  };
  const hide = (h) => {
    hidden = h;
    card.hidden = h;
    pill.hidden = !h;
  };
  card.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dl]');
    if (!b) return;
    if (b.dataset.dl === 'hide') hide(true);
    if (b.dataset.dl === 'cancel') ctl.cancel();
  });
  pill.addEventListener('click', () => {
    if (pill.dataset.done) {
      pill.remove();
      if (pill.dataset.book) nav(`#/read/${pill.dataset.book}`);
      return;
    }
    hide(false);
  });
  draw();
  try {
    const book = await run((f) => {
      fraction = f;
      draw();
    }, ctl);
    card.remove();
    if (!hidden) {
      pill.remove();
      return { book, hidden: false };
    }
    // Finished while put away: say so in the pill for a while (tap to open).
    pill.dataset.done = '1';
    if (book) pill.dataset.book = book.id;
    pill.classList.add('done');
    pill.innerHTML = `<span class="dl-pill-text">${esc(title)}</span><span class="dl-pill-pct">Open</span>`;
    setTimeout(() => pill.remove(), 12000);
    return { book, hidden: true };
  } catch (e) {
    card.remove();
    pill.remove();
    if (ctl.cancelled) return null;
    throw e;
  }
}
