import { icons } from '../icons.js';
import { listBooks } from '../db.js';
import { importFile, isSupportedFile } from '../pdf.js';

export const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Top navigation bar shared by Home / Library / Settings. Returns the content element. */
export function shell(view, active) {
  view.classList.add('shell');
  // Settings remembers where it was opened from, so it can always offer a way back.
  const from = active === 'settings' ? new URLSearchParams(location.hash.split('?')[1] || '').get('from') : null;
  const backTo = from && /^#\/(read\/|library|$)/.test(from) ? from : null;
  const backLabel = backTo?.startsWith('#/read/') ? 'Back to book' : 'Back';
  const here = encodeURIComponent(location.hash || '#/');
  view.innerHTML = `
    <header class="topbar">
      ${
        backTo
          ? `<a class="back-pill" href="${esc(backTo)}">${icons.back}<span>${backLabel}</span></a>`
          : `<a class="wordmark" href="#/" aria-label="Folio home"><span class="mark">${icons.book}</span>Folio</a>`
      }
      <nav class="tabs" aria-label="Main">
        <a href="#/" class="${active === 'home' ? 'on' : ''}" ${active === 'home' ? 'aria-current="page"' : ''}>Reading Room</a>
        <a href="#/library" class="${active === 'library' ? 'on' : ''}" ${active === 'library' ? 'aria-current="page"' : ''}>Library</a>
      </nav>
      <a class="icon-btn ${active === 'settings' ? 'on' : ''}" href="${active === 'settings' ? esc(location.hash) : `#/settings?from=${here}`}" aria-label="Settings">${icons.settings}</a>
    </header>
    <main class="content"></main>
    <div class="toast" hidden></div>`;
  return view.querySelector('.content');
}

export function toast(view, msg, ms = 2600) {
  const t = view.querySelector('.toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), ms);
}

/** Object URLs for cover blobs, revoked together on cleanup. */
export function coverUrls() {
  const urls = new Map();
  return {
    /**
     * Copy the covers into memory first. Older iOS often refuses to show an
     * image straight from a blob stored in IndexedDB ("WebKitBlobResource
     * error"), even though reading the same blob's bytes works.
     */
    load(books) {
      return Promise.all(
        books.map(async (b) => {
          if (!b.cover || urls.has(b.id)) return;
          try {
            const bytes = await b.cover.arrayBuffer();
            urls.set(b.id, URL.createObjectURL(new Blob([bytes], { type: b.cover.type || 'image/jpeg' })));
          } catch (e) {}
        }),
      );
    },
    get(book) {
      if (!book.cover) return '';
      if (!urls.has(book.id)) urls.set(book.id, URL.createObjectURL(book.cover));
      return urls.get(book.id);
    },
    revoke() {
      for (const u of urls.values()) URL.revokeObjectURL(u);
      urls.clear();
    },
  };
}

export function progressOf(book) {
  if (book.finished) return 1;
  if (!book.lastOpenedAt || book.pageCount <= 1) return 0;
  return Math.min(1, (book.lastPage - 1) / (book.pageCount - 1));
}

/** Open the system file picker and import the chosen PDFs. */
export function pickFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,application/pdf';
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve([...(input.files || [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => (resolve([]), input.remove()));
    document.body.append(input);
    input.click();
  });
}

export async function importFiles(files, view, onProgress) {
  const pdfs = files.filter(isSupportedFile);
  const skipped = files.length - pdfs.length;
  if (!pdfs.length) {
    if (skipped) toast(view, 'Only PDF books are supported for now');
    return 0;
  }
  const ids = new Set((await listBooks()).map((b) => b.id));
  let added = 0;
  let dupes = 0;
  for (let i = 0; i < pdfs.length; i++) {
    onProgress?.(i, pdfs.length, pdfs[i].name);
    try {
      const book = await importFile(pdfs[i], ids);
      if (book) {
        ids.add(book.id);
        added++;
      } else dupes++;
    } catch (e) {
      console.error(e);
      toast(view, `Couldn't open “${pdfs[i].name}”`);
    }
  }
  onProgress?.(pdfs.length, pdfs.length);
  const parts = [];
  if (added) parts.push(`${added} book${added > 1 ? 's' : ''} added`);
  if (dupes) parts.push(`${dupes} already in your library`);
  if (skipped) parts.push(`${skipped} unsupported file${skipped > 1 ? 's' : ''} skipped`);
  if (parts.length) toast(view, parts.join(' · '));
  return added;
}

/** Overlay shown while importing. */
export function importOverlay(view) {
  const el = document.createElement('div');
  el.className = 'import-overlay';
  el.innerHTML = `<div class="import-card"><div class="spinner"></div><p class="import-title">Adding to your library</p><p class="import-name"></p></div>`;
  view.append(el);
  return {
    update(i, n, name) {
      el.querySelector('.import-name').textContent = name ? `${i + 1} of ${n} · ${name}` : '';
    },
    done() {
      el.remove();
    },
  };
}

/** Enable dropping PDF files anywhere on the view (desktop convenience). */
export function enableDrop(view, onFiles) {
  const over = (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) {
      e.preventDefault();
      view.classList.add('dropping');
    }
  };
  const leave = (e) => {
    if (e.target === view || !view.contains(e.relatedTarget)) view.classList.remove('dropping');
  };
  const drop = (e) => {
    e.preventDefault();
    view.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(files);
  };
  view.addEventListener('dragover', over);
  view.addEventListener('dragleave', leave);
  view.addEventListener('drop', drop);
}

export async function addBooksFlow(view, after, files) {
  files ??= await pickFiles();
  if (!files.length) return;
  const overlay = importOverlay(view);
  try {
    await importFiles(files, view, (i, n, name) => overlay.update(i, n, name));
  } finally {
    overlay.done();
  }
  await after?.();
}
