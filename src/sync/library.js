// Books in Google Drive that aren't on this device, as the library shows them.
import './sync.css';
import { cloudBooks, driveCopy } from './engine.js';
import { driveOn, downloadBook, removeDownload, removeCloudBook } from './drive.js';
import { withProgress } from './downloads.js';
import { familyList, familyCached, ownerName, downloadFamilyBook } from './family.js';
import { listBooks } from '../db.js';
import { status } from './index.js';

const mb = (n) => (n > 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export const cloudIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18.5h10.2a4.3 4.3 0 0 0 .6-8.56A6 6 0 0 0 6.3 9.1 4.75 4.75 0 0 0 7 18.5z"/></svg>';

function dataUrlToBlob(url) {
  try {
    const [head, body] = url.split(',');
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: (/data:([^;]+)/.exec(head) || [])[1] || 'image/jpeg' });
  } catch (e) {
    return null;
  }
}

/** A plain cover for a book nobody has opened yet (found in the Drive folder): its title on cloth. */
const plainCovers = new Map();
function plainCover(title, format) {
  const key = title + '|' + format;
  if (plainCovers.has(key)) return plainCovers.get(key);
  let blob = null;
  try {
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = 360;
    const ctx = c.getContext('2d');
    let h = 0;
    for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = [18, 205, 150, 340, 40, 260][h % 6];
    const g = ctx.createLinearGradient(0, 0, 0, 360);
    g.addColorStop(0, `hsl(${hue},28%,32%)`);
    g.addColorStop(1, `hsl(${hue},32%,20%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 240, 360);
    ctx.strokeStyle = 'rgba(232,205,160,0.5)';
    ctx.strokeRect(12, 12, 216, 336);
    ctx.fillStyle = '#efe3cc';
    ctx.textAlign = 'center';
    ctx.font = '600 22px Georgia, serif';
    const words = title.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > 190 && line) lines.push(line), (line = w);
      else line = t;
    }
    lines.push(line);
    let y = 150 - ((Math.min(lines.length, 6) - 1) * 27) / 2;
    for (const l of lines.slice(0, 6)) ctx.fillText(l, 120, y), (y += 27);
    ctx.font = '600 11px sans-serif';
    ctx.fillStyle = 'rgba(239,227,204,0.6)';
    ctx.fillText(format === 'epub' ? 'EPUB' : format === 'comic' ? 'COMIC' : 'PDF', 120, 320);
    blob = dataUrlToBlob(c.toDataURL('image/jpeg', 0.85));
  } catch (e) {}
  plainCovers.set(key, blob);
  return blob;
}

/** Library entries for books only in Drive (while Drive is on): look like books, with `cloud: true`. */
export async function cloudLibrary() {
  if (!driveOn()) return [];
  return (await cloudBooks()).map((c) => {
    const m = c.meta || {};
    const p = c.prog || {};
    const prog = typeof p.lastPage === 'number' ? p.lastPage : 1; // an EPUB place can't be shown as a page here
    return {
      id: 'cloud-' + c.sid,
      cloud: true,
      syncId: c.sid,
      format: m.format,
      title: m.title || 'Untitled',
      author: m.author || (m.pageCount ? '' : `${m.format === 'epub' ? 'EPUB' : m.format === 'comic' ? 'Comic' : 'PDF'} · ${mb(m.size || 0)}`),
      pageCount: m.pageCount || 0,
      aspect: m.aspect || 0.7,
      addedAt: m.addedAt || 0,
      size: (c.drive && c.drive.size) || m.size || 0,
      lastOpenedAt: p.lastOpenedAt || 0,
      lastPage: prog,
      finished: !!p.finished,
      seriesName: c.series ? c.series.name : undefined,
      seriesIndex: c.series && c.series.index != null ? c.series.index : undefined,
      cover: c.cover ? dataUrlToBlob(c.cover) : plainCover(m.title || 'Untitled', m.format),
    };
  });
}

/** Content ids of the local books that also have a copy in Drive. */
export async function inDrive(books) {
  const out = new Set();
  if (!driveOn()) return out;
  for (const b of books) if (!b.cloud && b.syncId && (await driveCopy(b.syncId))) out.add(b.id);
  return out;
}


/** Download a cloud book (with a quiet progress card), then open it. */
export async function openCloudBook(view, book, nav) {
  const got = await withProgress({ title: book.title, from: 'Google Drive', size: book.size, key: 'drive:' + book.syncId }, (onProgress, ctl) => downloadBook(book.syncId, onProgress, ctl));
  if (!got) return null; // cancelled
  if (got.book && !got.hidden) nav(`#/read/${got.book.id}`);
  return got.book;
}

/**
 * Removing a book that is on this device, while sync is on: ask whether it
 * goes from this device only (its place, bookmarks and marks stay in the
 * account) or from the library on every device. Resolves 'here', 'all' or
 * null (cancelled). Without an account, a plain confirmation.
 */
export function askRemove(view, book, hasCopy) {
  if (!status().signedIn) {
    return Promise.resolve(confirm(`Remove “${book.title}” from your library? The file on your device is not affected.`) ? 'all' : null);
  }
  return new Promise((resolve) => {
    const sheet = document.createElement('div');
    sheet.className = 'sheet-backdrop';
    sheet.innerHTML = `
      <div class="sheet remove-sheet" role="dialog" aria-modal="true" aria-label="Remove book">
        <h2>Remove book</h2>
        <p class="sheet-sub"></p>
        <button class="rm-choice" data-r="here"><b>From this device</b><span>${hasCopy ? 'Frees the space here. It stays in your library and in Google Drive, with your place and bookmarks.' : 'Frees the space here. Your place and bookmarks are kept: add the file again any time and they come back.'}</span></button>
        <button class="rm-choice danger" data-r="all"><b>From all my devices</b><span>${hasCopy ? 'Removes it from your library everywhere. Its copy in Google Drive moves to the Drive trash.' : 'Removes it from your library on every device signed in to your account.'}</span></button>
        <div class="sheet-actions"><button class="btn subtle" data-r="">Cancel</button></div>
      </div>`;
    sheet.querySelector('.sheet-sub').textContent = book.title;
    view.append(sheet);
    sheet.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (!b && e.target !== sheet) return;
      sheet.remove();
      resolve(b ? b.dataset.r || null : null);
    });
  });
}

/** Menu items for a book card (Drive-related ones). */
export function cloudMenu(book, hasCopy, icons) {
  if (book.cloud) {
    return `
      <button role="menuitem" data-m="download">${cloudIcon} Download for offline</button>
      <button role="menuitem" data-m="cloudremove" class="danger">${icons.trash} Remove from library</button>`;
  }
  return hasCopy ? `<button role="menuitem" data-m="undownload">${cloudIcon} Remove download</button>` : '';
}

/** Handle a Drive-related menu choice. Returns a message to show, or null if it wasn't one. */
export async function cloudMenuAction(m, book, view, nav) {
  if (m === 'download') {
    const got = await openCloudBook(view, book, () => {});
    return got ? 'Downloaded · ready offline' : '';
  }
  if (m === 'undownload') {
    if (!confirm(`Remove the download of “${book.title}” from this device? It stays in your library and in Google Drive, with your progress; download it again any time.`)) return '';
    await removeDownload(book.id);
    return 'Download removed';
  }
  if (m === 'cloudremove') {
    if (!confirm(`Remove “${book.title}” from your library on all your devices? Its copy in Google Drive moves to the Drive trash.`)) return '';
    await removeCloudBook(book.syncId);
    return 'Removed from library';
  }
  return null;
}

// ---------------------------------------------------------------- family libraries

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Libraries shared with this account: the last list at once (never waits for the network), refreshed in the background. */
export async function familyLibraries() {
  const last = familyCached();
  const fresh = familyList(true).catch(() => null);
  const list = last || (await Promise.race([fresh, new Promise((r) => setTimeout(r, 1200))]));
  return list ? list.libraries.filter((l) => l.books.length) : [];
}

/** One shelf card per family library, for the end of the library grid. */
export function familyShelves(libraries) {
  return libraries
    .map((lib) => {
      const covers = lib.books.filter((b) => b.cover).slice(0, 3);
      const n = lib.books.length;
      return `
        <article class="card series-card family-card">
          <a class="card-cover stacked" href="#/library?family=${encodeURIComponent(lib.owner)}" aria-label="${escHtml(ownerName(lib.email))}’s library, ${n} books">
            ${covers.map((b, i) => `<span class="book3d s${covers.length - 1 - i}" style="--ar:${(b.meta && b.meta.aspect) || 0.7}"><img src="${b.cover}" alt="" loading="lazy"></span>`).join('')}
            <span class="badge count">${n}</span>
          </a>
          <div class="card-info"><div class="card-text"><h3>${escHtml(ownerName(lib.email))}’s library</h3><p>Family · ${n} book${n === 1 ? '' : 's'}</p></div></div>
        </article>`;
    })
    .join('');
}

/** The page of one family library: its books; opening one downloads it to this device. */
export async function mountFamilyPage(content, owner, view, nav, toast) {
  content.innerHTML = `
    <section class="lib-head series-head">
      <div>
        <a class="crumb" href="#/library">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>'}<span>Library</span></a>
        <h1>Family library</h1>
        <p class="lib-count"></p>
      </div>
    </section>
    <section class="grid" aria-live="polite"></section>`;
  const grid = content.querySelector('.grid');
  let lib = null;
  let local = new Map();
  async function draw(fresh) {
    try {
      lib = (await familyList(fresh)).libraries.find((l) => l.owner === owner) || null;
    } catch (e) {
      lib = null;
    }
    if (!lib) {
      content.querySelector('h1').textContent = 'Family library';
      content.querySelector('.lib-count').textContent = '';
      grid.innerHTML = `<p class="no-results">${navigator.onLine === false ? 'You’re offline. Family libraries need a connection.' : 'This library isn’t shared with you any more.'}</p>`;
      return;
    }
    local = new Map((await listBooks()).filter((b) => b.syncId).map((b) => [b.syncId, b]));
    content.querySelector('h1').textContent = `${ownerName(lib.email)}’s library`;
    content.querySelector('.lib-count').textContent = `${lib.books.length} book${lib.books.length === 1 ? '' : 's'} · shared by ${lib.email} · your progress is your own`;
    const books = lib.books.slice().sort((a, b) => (a.meta.title || '').localeCompare(b.meta.title || ''));
    grid.innerHTML = books
      .map((b) => {
        const here = local.get(b.sid);
        return `
        <article class="card${here ? '' : ' is-cloud'}" data-sid="${escHtml(b.sid)}">
          <a class="card-cover" href="${here ? `#/read/${here.id}` : '#'}" aria-label="Open ${escHtml(b.meta.title)}">
            <span class="book3d" style="--ar:${b.meta.aspect || 0.7}">${b.cover ? `<img src="${b.cover}" alt="" loading="lazy">` : ''}</span>
            ${here ? '' : `<span class="badge cloud" title="Tap to download">${cloudIcon}</span>`}
          </a>
          <div class="card-info"><div class="card-text"><h3>${escHtml(b.meta.title)}</h3><p>${escHtml(b.meta.author || (b.meta.pageCount ? `${b.meta.pageCount} pages` : ''))}</p></div></div>
        </article>`;
      })
      .join('');
  }
  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.card.is-cloud');
    if (!card || !lib) return;
    e.preventDefault();
    const b = lib.books.find((x) => x.sid === card.dataset.sid);
    try {
      const size = (b.drive && b.drive.size) || (b.meta && b.meta.size) || 0;
      const got = await withProgress({ title: b.meta.title, from: `${ownerName(lib.email)}’s library`, size, key: 'family:' + b.sid }, (onProgress, ctl) => downloadFamilyBook(owner, b, onProgress, ctl));
      if (got && got.book && !got.hidden) nav(`#/read/${got.book.id}`);
    } catch (err) {
      toast(view, err.message || 'Download failed', 4000);
    }
  });
  await draw(false);
  draw(true); // and refresh from the server
}
