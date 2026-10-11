// How the library and settings map onto sync items, and back.
//
// A book is known everywhere by its content id (`syncId`), not by its local
// id: the same file has the same content id on every device, whatever its
// file name there.
//   b:<sid>:meta     title, author … (a tombstone: removed from the library)
//   b:<sid>:prog     lastPage, readingPos, finished (+ lastOpenedAt, from)
//   b:<sid>:series   { name, index } once set by hand
//   b:<sid>:comic    a comic's reading mode { rtl, view } (its page numbers depend on it)
//   b:<sid>:stop     "Where I stopped"
//   b:<sid>:bm:<n>   bookmark on page n, with its note
//   b:<sid>:cover    a small cover picture (for books not on this device)
//   b:<sid>:drive    { id, size } of its copy in the account's Google Drive
//   s:<setting>      one setting
//   st:<device>:<day> seconds read that day on that device

/** Content id of a book file: size plus its first and last 64 KB. null where hashing isn't available (plain-http address). */
export async function contentId(blob) {
  if (!(window.crypto && crypto.subtle) || !blob) return null;
  const size = blob.size;
  const CHUNK = 65536;
  const parts = [new TextEncoder().encode(`folio1|${size}|`), new Uint8Array(await blob.slice(0, CHUNK).arrayBuffer())];
  if (size > CHUNK) parts.push(new Uint8Array(await blob.slice(Math.max(CHUNK, size - CHUNK)).arrayBuffer()));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  let hex = '';
  for (let i = 0; i < 16; i++) hex += (digest[i] < 16 ? '0' : '') + digest[i].toString(16);
  return hex;
}

const num = (x, dflt) => (typeof x === 'number' && isFinite(x) ? x : dflt);

// EPUB pages are set for each device (screen, text size), so page numbers
// don't travel: an EPUB position goes as the text its page starts at,
// "e<chapter>.<offset>", and comes back as whichever page holds that text here.
const starts = (book) => (book.epub && book.epub.starts && book.epub.starts.length ? book.epub.starts : null);

export function posOf(book, n) {
  const s = starts(book);
  if (!s || !n) return n;
  // A position that came from another device stays exactly as it came while
  // it is still on this page (so it doesn't creep back and forth).
  const kept = book.syncPos && book.syncPos[n];
  if (kept && pageOf(book, kept) === n) return kept;
  const i = Math.min(Math.max(1, Math.round(n)), s.length / 2) - 1;
  return `e${s[2 * i]}.${s[2 * i + 1]}`;
}

export function pageOf(book, pos) {
  if (typeof pos === 'number') return pos;
  const m = /^e(\d+)\.(\d+)$/.exec(pos || '');
  const s = starts(book);
  if (!m || !s) return 1;
  const ch = +m[1];
  const o = +m[2];
  let lo = 0;
  let hi = s.length / 2 - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[2 * mid] < ch || (s[2 * mid] === ch && s[2 * mid + 1] <= o)) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * The items a local book stands for: [{ k, v, seed }]. `seed` is the time to
 * use when this device has never synced the item: the moment it really
 * happened, when the book records it (so an old device signing in for the
 * first time doesn't overrule newer reading elsewhere).
 */
export function bookItems(book) {
  const sid = book.syncId;
  const out = [];
  const meta = { title: book.title || '', author: book.author || '', pageCount: book.pageCount || 0, size: book.size || 0, fileName: book.fileName || '', aspect: book.aspect || 0.7, addedAt: book.addedAt || 0 };
  if (book.format) meta.format = book.format;
  out.push({ k: `b:${sid}:meta`, v: meta, seed: book.addedAt || 0 });
  const started = (book.lastPage || 1) > 1 || book.finished || !!book.lastOpenedAt;
  out.push({
    k: `b:${sid}:prog`,
    v: { lastPage: posOf(book, book.lastPage || 1), readingPos: posOf(book, book.readingPos || book.lastPage || 1), finished: !!book.finished, lastOpenedAt: book.lastOpenedAt || 0 },
    seed: started ? book.lastOpenedAt || 1 : 0,
  });
  if (book.seriesName !== undefined) out.push({ k: `b:${sid}:series`, v: { name: book.seriesName, index: book.seriesIndex == null ? null : book.seriesIndex }, seed: book.addedAt || 0 });
  if (book.comic) out.push({ k: `b:${sid}:comic`, v: { rtl: !!book.comic.rtl, view: book.comic.view === 'scroll' ? 'scroll' : 'pages' }, seed: book.addedAt || 0 });
  if (book.stopMark) out.push({ k: `b:${sid}:stop`, v: Object.assign({}, book.stopMark, { page: posOf(book, book.stopMark.page) }), seed: book.stopMark.at || 0 });
  const seen = new Set();
  for (const b of book.bookmarks || []) {
    const v = { at: b.at || 0 };
    if (b.note) v.note = b.note;
    const k = `b:${sid}:bm:${posOf(book, b.page)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ k, v, seed: b.at || 0 });
  }
  return out;
}

/** A small JPEG of a cover (as a data: address), for showing books that aren't on this device. */
export function coverThumb(blob, width = 120) {
  return new Promise((resolve) => {
    if (!blob) return resolve(null);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * width));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const data = c.toDataURL('image/jpeg', 0.72);
        c.width = c.height = 0;
        resolve(data.length < 14000 ? data : null);
      } catch (e) {
        resolve(null);
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => (URL.revokeObjectURL(url), resolve(null));
    img.src = url;
  });
}

/** Are two values of this item the same, for sync's purposes? */
export function sameValue(k, a, b) {
  if (/:prog$/.test(k) && a && b) return a.lastPage === b.lastPage && a.readingPos === b.readingPos && !!a.finished === !!b.finished;
  return stable(a) === stable(b);
}

function stable(x) {
  if (x === undefined) return 'null';
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']';
  return (
    '{' +
    Object.keys(x)
      .filter((k) => x[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stable(x[k]))
      .join(',') +
    '}'
  );
}

/** Remember EPUB positions as they came (see posOf): [[page, position]]. */
function keep(patch, pairs) {
  const add = pairs.filter((x) => typeof x[1] === 'string');
  if (add.length) {
    patch.syncPos = {};
    for (const [page, pos] of add) patch.syncPos[page] = pos;
  }
  return patch;
}

/** Split a key into its parts: { kind: 'book' | 'setting' | 'stats', sid, field, page, … }. */
export function parseKey(k) {
  let m = /^b:([0-9a-f]+):(meta|prog|series|stop|cover|drive|comic)$/.exec(k);
  if (m) return { kind: 'book', sid: m[1], field: m[2] };
  m = /^b:([0-9a-f]+):bm:(\d+|e\d+\.\d+)$/.exec(k);
  if (m) return { kind: 'book', sid: m[1], field: 'bm', pos: /^\d+$/.test(m[2]) ? +m[2] : m[2] };
  m = /^s:(\w+)$/.exec(k);
  if (m) return { kind: 'setting', key: m[1] };
  m = /^st:([\w-]+):(\d{4}-\d\d-\d\d)$/.exec(k);
  if (m) return { kind: 'stats', dev: m[1], day: m[2] };
  return { kind: 'other' };
}

/**
 * The change to make to a local book for a remote item (a patch for
 * updateBook), given all items known for that book (for bookmarks, which
 * are rebuilt as a list). Returns null when nothing needs to change.
 */
export function patchFor(book, item, items) {
  const p = parseKey(item.k);
  if (p.field === 'prog') {
    if (item.d || !item.v) return null;
    const v = item.v;
    const max = book.pageCount || Infinity;
    const clamp = (pos) => Math.max(1, Math.min(max, Math.round(num(pageOf(book, pos), 1))));
    const out = { lastPage: clamp(v.lastPage), readingPos: clamp(v.readingPos || v.lastPage), finished: !!v.finished, lastOpenedAt: Math.max(book.lastOpenedAt || 0, num(v.lastOpenedAt, 0)) };
    return keep(out, [[out.lastPage, v.lastPage], [out.readingPos, v.readingPos || v.lastPage]]);
  }
  if (p.field === 'series') {
    if (item.d || !item.v) return { seriesName: undefined, seriesIndex: undefined };
    return { seriesName: typeof item.v.name === 'string' ? item.v.name : undefined, seriesIndex: item.v.index == null ? undefined : num(item.v.index, undefined) };
  }
  if (p.field === 'comic') {
    if (item.d || !item.v) return null;
    return { comic: { rtl: !!item.v.rtl, view: item.v.view === 'scroll' ? 'scroll' : 'pages' } };
  }
  if (p.field === 'stop') {
    if (item.d || !item.v) return { stopMark: null };
    const page = pageOf(book, item.v.page);
    return keep({ stopMark: Object.assign({}, item.v, { page }) }, [[page, item.v.page]]);
  }
  if (p.field === 'bm') {
    const prefix = `b:${book.syncId}:bm:`;
    // Bookmarks sync doesn't know about yet stay; the rest follow the items.
    const list = (book.bookmarks || []).filter((b) => !items.has(prefix + posOf(book, b.page)));
    const taken = new Set(list.map((b) => b.page));
    const kept = [];
    for (const it of items.values()) {
      if (it.d || it.k.indexOf(prefix) !== 0) continue;
      const pos = it.k.slice(prefix.length);
      const page = pageOf(book, /^\d+$/.test(pos) ? +pos : pos);
      if (!(page >= 1) || taken.has(page)) continue;
      taken.add(page);
      kept.push([page, /^\d+$/.test(pos) ? +pos : pos]);
      const b = { page, at: (it.v && it.v.at) || 0 };
      if (it.v && it.v.note) b.note = it.v.note;
      list.push(b);
    }
    list.sort((a, b) => a.page - b.page);
    return keep({ bookmarks: list }, kept);
  }
  return null;
}

/** A book file's type and extension, from its format and file name. */
export function fileKind(format, fileName) {
  const ext = ((fileName || '').match(/\.(pdf|epub|cbz|cbr)$/i) || [])[1];
  const e = (ext || (format === 'epub' ? 'epub' : format === 'comic' ? 'cbz' : 'pdf')).toLowerCase();
  const type = { pdf: 'application/pdf', epub: 'application/epub+zip', cbz: 'application/vnd.comicbook+zip', cbr: 'application/vnd.comicbook-rar' }[e];
  return { ext: e, type };
}
