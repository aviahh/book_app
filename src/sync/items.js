// How the library and settings map onto sync items, and back.
//
// A book is known everywhere by its content id (`syncId`), not by its local
// id: the same file has the same content id on every device, whatever its
// file name there.
//   b:<sid>:meta     title, author … (a tombstone: removed from the library)
//   b:<sid>:prog     lastPage, readingPos, finished (+ lastOpenedAt, from)
//   b:<sid>:series   { name, index } once set by hand
//   b:<sid>:stop     "Where I stopped"
//   b:<sid>:bm:<n>   bookmark on page n, with its note
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
    v: { lastPage: book.lastPage || 1, readingPos: book.readingPos || book.lastPage || 1, finished: !!book.finished, lastOpenedAt: book.lastOpenedAt || 0 },
    seed: started ? book.lastOpenedAt || 1 : 0,
  });
  if (book.seriesName !== undefined) out.push({ k: `b:${sid}:series`, v: { name: book.seriesName, index: book.seriesIndex == null ? null : book.seriesIndex }, seed: book.addedAt || 0 });
  if (book.stopMark) out.push({ k: `b:${sid}:stop`, v: book.stopMark, seed: book.stopMark.at || 0 });
  for (const b of book.bookmarks || []) {
    const v = { at: b.at || 0 };
    if (b.note) v.note = b.note;
    out.push({ k: `b:${sid}:bm:${b.page}`, v, seed: b.at || 0 });
  }
  return out;
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

/** Split a key into its parts: { kind: 'book' | 'setting' | 'stats', sid, field, page, … }. */
export function parseKey(k) {
  let m = /^b:([0-9a-f]+):(meta|prog|series|stop)$/.exec(k);
  if (m) return { kind: 'book', sid: m[1], field: m[2] };
  m = /^b:([0-9a-f]+):bm:(\d+)$/.exec(k);
  if (m) return { kind: 'book', sid: m[1], field: 'bm', page: +m[2] };
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
    const clamp = (n) => Math.max(1, Math.min(max, Math.round(num(n, 1))));
    return { lastPage: clamp(v.lastPage), readingPos: clamp(v.readingPos || v.lastPage), finished: !!v.finished, lastOpenedAt: Math.max(book.lastOpenedAt || 0, num(v.lastOpenedAt, 0)) };
  }
  if (p.field === 'series') {
    if (item.d || !item.v) return { seriesName: undefined, seriesIndex: undefined };
    return { seriesName: typeof item.v.name === 'string' ? item.v.name : undefined, seriesIndex: item.v.index == null ? undefined : num(item.v.index, undefined) };
  }
  if (p.field === 'stop') return { stopMark: item.d ? null : item.v };
  if (p.field === 'bm') {
    const prefix = `b:${book.syncId}:bm:`;
    // Bookmarks sync doesn't know about yet stay; the rest follow the items.
    const list = (book.bookmarks || []).filter((b) => !items.has(prefix + b.page));
    for (const it of items.values()) {
      if (it.d || it.k.indexOf(prefix) !== 0) continue;
      const page = +it.k.slice(prefix.length);
      if (!(page >= 1)) continue;
      const b = { page, at: (it.v && it.v.at) || 0 };
      if (it.v && it.v.note) b.note = it.v.note;
      list.push(b);
    }
    list.sort((a, b) => a.page - b.page);
    return { bookmarks: list };
  }
  return null;
}
