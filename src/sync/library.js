// Books in Google Drive that aren't on this device, as the library shows them.
import './sync.css';
import { cloudBooks, driveCopy } from './engine.js';
import { driveOn, downloadBook, removeDownload, removeCloudBook } from './drive.js';

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
      author: m.author || '',
      pageCount: m.pageCount || 0,
      aspect: m.aspect || 0.7,
      addedAt: m.addedAt || 0,
      size: (c.drive && c.drive.size) || m.size || 0,
      lastOpenedAt: p.lastOpenedAt || 0,
      lastPage: prog,
      finished: !!p.finished,
      seriesName: c.series ? c.series.name : undefined,
      seriesIndex: c.series && c.series.index != null ? c.series.index : undefined,
      cover: c.cover ? dataUrlToBlob(c.cover) : null,
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

const mb = (n) => (n > 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Download a cloud book (with a quiet progress card), then open it. */
export async function openCloudBook(view, book, nav) {
  const el = document.createElement('div');
  el.className = 'import-overlay';
  el.innerHTML = `<div class="import-card"><div class="spinner"></div><p class="import-title">Downloading from Google Drive</p><p class="import-name"></p><div class="sync-bar"><i></i></div></div>`;
  el.querySelector('.import-name').textContent = `${book.title}${book.size ? ' · ' + mb(book.size) : ''}`;
  view.append(el);
  try {
    const local = await downloadBook(book.syncId, (f) => (el.querySelector('.sync-bar i').style.width = `${Math.round(f * 100)}%`));
    el.remove();
    if (local) nav(`#/read/${local.id}`);
    return local;
  } catch (e) {
    el.remove();
    throw e;
  }
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
    await openCloudBook(view, book, () => {});
    return 'Downloaded · ready offline';
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
