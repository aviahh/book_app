// Series: books that belong together ("Re:ZERO, Vol. 1", "Vol. 2" …) are
// shown as one shelf in the library, volumes in order.
//
// A book's series comes from its title ("<name> Vol. 3", "<name> Book 3",
// "<name> 03" …) unless the reader set one by hand:
//   book.seriesName  undefined → detect from the title
//                    ''        → not part of a series
//                    'Name'    → in that series
//   book.seriesIndex the volume number when set by hand (else from the title)
// A detected series only forms a shelf once at least two books share it.

const MARKED = /^(.*?)[\s,:;._\-–—([]*\b(?:volume|vol|book|part|tome|v(?=\d)|#)\s*\.?\s*(\d{1,3}(?:\.\d)?)\b(.*)$/i;
const TRAILING = /^(.*?\D)[\s,:;_\-–—#([]+(\d{1,3}(?:\.\d)?)\s*[)\]]?\s*$/;

const clean = (s) => s.replace(/[\s,:;._\-–—([]+$/, '').replace(/^[\s,:;._\-–—)\]]+/, '').trim();
const keyOf = (name) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Series name and volume number read from a title, or null. */
export function parseTitle(title = '') {
  const t = title.trim();
  let m = MARKED.exec(t);
  if (m && clean(m[1]).length >= 2) return { name: clean(m[1]), index: parseFloat(m[2]) };
  m = TRAILING.exec(t);
  if (m && clean(m[1]).length >= 2) return { name: clean(m[1]), index: parseFloat(m[2]) };
  return null;
}

/** The series a book is in (name, key, volume number), or null. */
export function seriesOf(book) {
  if (book.seriesName === '') return null;
  const parsed = parseTitle(book.title);
  if (book.seriesName) {
    const index = book.seriesIndex != null ? book.seriesIndex : parsed ? parsed.index : null;
    return { name: book.seriesName, key: keyOf(book.seriesName), index, manual: true };
  }
  return parsed ? { name: parsed.name, key: keyOf(parsed.name), index: parsed.index, manual: false } : null;
}

const byVolume = (a, b) => {
  const x = a.series.index;
  const y = b.series.index;
  if (x != null && y != null && x !== y) return x - y;
  if (x != null && y == null) return -1;
  if (x == null && y != null) return 1;
  return (a.book.addedAt || 0) - (b.book.addedAt || 0);
};

/**
 * Group a library into series shelves and single books.
 * Returns { groups: [{ key, name, books }], singles: [book] }; each group's
 * books are in volume order.
 */
export function groupSeries(books) {
  const map = new Map();
  const singles = [];
  for (const book of books) {
    const series = seriesOf(book);
    if (!series || !series.key) {
      singles.push(book);
      continue;
    }
    if (!map.has(series.key)) map.set(series.key, { key: series.key, name: series.name, items: [], manual: false });
    const g = map.get(series.key);
    g.items.push({ book, series });
    if (series.manual) {
      g.manual = true;
      g.name = series.name; // a name typed by hand wins over one read from a title
    }
  }
  const groups = [];
  for (const g of map.values()) {
    if (g.items.length < 2 && !g.manual) {
      singles.push(g.items[0].book);
      continue;
    }
    g.items.sort(byVolume);
    groups.push({ key: g.key, name: g.name, books: g.items.map((x) => x.book), volumes: g.items.map((x) => x.series.index) });
  }
  return { groups, singles };
}

/** The next volume to read after `book` in its series (not finished), or null. */
export function nextInSeries(book, books) {
  const { groups } = groupSeries(books);
  const g = groups.find((x) => x.books.some((b) => b.id === book.id));
  if (!g) return null;
  const i = g.books.findIndex((b) => b.id === book.id);
  const next = g.books.slice(i + 1).find((b) => !b.finished);
  return next ? { book: next, series: g } : null;
}

/** "Vol. 3" label for a book in a group (or ''). */
export const volumeLabel = (n) => (n == null ? '' : `Vol. ${n}`);
