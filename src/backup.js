// Backup and restore: the library, reading progress, settings and reading
// statistics in one file, optionally with the books themselves.
//
// File layout (built from Blob parts, so even a backup with many large books
// is never copied into memory as a whole):
//   "FOLIOBK1"                8 bytes, ASCII
//   header length             12 ASCII digits
//   header                    JSON (UTF-8)
//   payload                   covers and PDF files, back to back; the header
//                             records each one's offset and size
import { listBooks, getBookFile, addBook, updateBook } from './db.js';
import { getSettings, setSetting, DEFAULTS } from './settings.js';

const MAGIC = 'FOLIOBK1';
const STATS_KEY = 'folio.stats.v1';
const PENDING_KEY = 'folio.pendingProgress.v1';

const readJson = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch (e) {
    return {};
  }
};
const writeJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
};

/** Sizes, for showing in Settings before backing up. */
export async function backupSizes() {
  const books = await listBooks();
  return { count: books.length, bookBytes: books.reduce((n, b) => n + (b.size || 0), 0) };
}

/** Build the backup file. `withBooks` also stores the PDFs (and their covers). */
export async function createBackup({ withBooks }) {
  const books = await listBooks();
  const parts = [];
  let offset = 0;
  const put = (blob) => {
    const at = { offset, size: blob.size, type: blob.type || '' };
    parts.push(blob);
    offset += blob.size;
    return at;
  };
  const records = [];
  for (const b of books) {
    const meta = Object.assign({}, b);
    delete meta.cover;
    const rec = { meta };
    if (withBooks) {
      const file = await getBookFile(b.id);
      if (file) {
        rec.file = put(file);
        if (b.cover) rec.cover = put(b.cover);
      }
    }
    records.push(rec);
  }
  const header = new TextEncoder().encode(
    JSON.stringify({
      app: 'Folio',
      version: 1,
      createdAt: Date.now(),
      withBooks: !!withBooks,
      settings: getSettings(),
      stats: readJson(STATS_KEY),
      books: records,
    }),
  );
  const len = String(header.length).padStart(12, '0');
  return new Blob([MAGIC, len, header, ...parts], { type: 'application/octet-stream' });
}

export function backupFileName(withBooks) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `Folio backup ${day}${withBooks ? ' (with books)' : ''}.folio`;
}

const text = (blob) => blob.arrayBuffer().then((b) => new TextDecoder().decode(b));

/**
 * Restore a backup file. Merges with what is already here: newer reading
 * progress wins, statistics keep the larger count per day, settings are
 * taken from the backup. Progress for books that aren't in the library (a
 * backup without books) is kept and applied when that book is added again.
 */
export async function restoreBackup(file, onProgress = () => {}) {
  if ((await text(file.slice(0, 8))) !== MAGIC) throw new Error('This isn’t a Folio backup file.');
  const len = parseInt(await text(file.slice(8, 20)), 10);
  if (!(len > 0)) throw new Error('This backup file is damaged.');
  const header = JSON.parse(await text(file.slice(20, 20 + len)));
  const base = 20 + len;
  const slice = (at) => file.slice(base + at.offset, base + at.offset + at.size, at.type || undefined);

  // Settings
  for (const k of Object.keys(DEFAULTS)) if (header.settings && k in header.settings) setSetting(k, header.settings[k]);

  // Reading statistics: per day, keep whichever count is larger.
  const stats = readJson(STATS_KEY);
  for (const [day, secs] of Object.entries(header.stats || {})) stats[day] = Math.max(stats[day] || 0, secs);
  writeJson(STATS_KEY, stats);

  // Books and progress
  const have = new Map((await listBooks()).map((b) => [b.id, b]));
  const pending = readJson(PENDING_KEY);
  const result = { added: 0, updated: 0, waiting: 0 };
  const list = header.books || [];
  for (let i = 0; i < list.length; i++) {
    const { meta, file: fileAt, cover: coverAt } = list[i];
    onProgress(i, list.length, meta.title);
    const mine = have.get(meta.id);
    if (mine) {
      if ((meta.lastOpenedAt || 0) > (mine.lastOpenedAt || 0)) {
        await updateBook(meta.id, progressOf(meta));
        result.updated++;
      }
    } else if (fileAt) {
      const book = Object.assign({}, meta, { cover: coverAt ? slice(coverAt) : null });
      // Copy into memory-backed blobs, so nothing points into the backup file.
      const pdf = new Blob([await slice(fileAt).arrayBuffer()], { type: 'application/pdf' });
      if (book.cover) book.cover = new Blob([await book.cover.arrayBuffer()], { type: book.cover.type || 'image/jpeg' });
      await addBook(book, pdf);
      result.added++;
    } else if (meta.lastOpenedAt) {
      const old = pending[meta.id];
      if (!old || meta.lastOpenedAt > old.lastOpenedAt) pending[meta.id] = Object.assign({ title: meta.title }, progressOf(meta));
      result.waiting++;
    }
  }
  writeJson(PENDING_KEY, pending);
  return result;
}

const progressOf = (b) => ({ lastPage: b.lastPage || 1, lastOpenedAt: b.lastOpenedAt || 0, finished: !!b.finished });

/** Progress restored from a backup for a book that is only now being added. Used once. */
export function takePendingProgress(id) {
  const pending = readJson(PENDING_KEY);
  const p = pending[id];
  if (!p) return null;
  delete pending[id];
  writeJson(PENDING_KEY, pending);
  return progressOf(p);
}
